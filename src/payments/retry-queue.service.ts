import { Injectable, Logger } from '@nestjs/common';
import { 
  FailedOrder, 
  OrderStatus, 
  FailureReason, 
  RetryStrategy,
  RetryResult 
} from './retry-queue.interface';
import { FragmentService } from './fragment.service';
import { BotService } from '../bot/bot.service';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Сервис для управления очередью повторных попыток
 * с защитой от дублирования начисления звёзд
 */
@Injectable()
export class RetryQueueService {
  private readonly logger = new Logger(RetryQueueService.name);
  
  // Путь к файлу хранения очереди
  private readonly queueFilePath = path.join(process.cwd(), 'data', 'retry-queue.json');
  
  // Максимальное количество попыток
  private readonly MAX_ATTEMPTS = 10;
  
  // Задержка между попытками (2 минуты)
  private readonly RETRY_DELAY_MS = 2 * 60 * 1000;
  
  constructor(
    private readonly fragmentService: FragmentService,
    private readonly botService: BotService,
  ) {}
  
  /**
   * Добавляет заказ в очередь повторных попыток с проверкой на дубликаты
   */
  async addFailedOrder(
    orderId: string,
    userId: number,
    chatId: number,
    recipientUsername: string,
    starsCount: number,
    isGift: boolean,
    failureReason: FailureReason,
    lastError: string,
    paymentMethod: string,
    paymentAmount: number,
    paymentCurrency: string,
    paymentTransactionId: string,
  ): Promise<void> {
    try {
      // Читаем существующую очередь
      const queue = await this.loadQueue();
      
      // ПРОВЕРКА НА ДУБЛИКАТЫ - самое важное!
      const existingOrder = queue.find(order => order.orderId === orderId);
      
      if (existingOrder) {
        this.logger.warn(`🚫 ДУБЛИКАТ! Заказ ${orderId} уже есть в очереди. Пропускаем добавление.`);
        
        // Если заказ уже завершён успешно - точно не добавляем
        if (existingOrder.status === OrderStatus.COMPLETED && existingOrder.lastSuccessfulFragmentOrderId) {
          this.logger.warn(`✅ Заказ ${orderId} уже успешно выполнен (Fragment ID: ${existingOrder.lastSuccessfulFragmentOrderId}). Игнорируем.`);
          return;
        }
        
        // Обновляем информацию об ошибке для существующего заказа
        existingOrder.lastError = lastError;
        existingOrder.failureReason = failureReason;
        existingOrder.lastAttemptAt = new Date();
        
        await this.saveQueue(queue);
        this.logger.log(`Обновлена информация об ошибке для заказа ${orderId}`);
        return;
      }
      
      // Проверяем, можно ли повторять этот тип ошибки
      if (!this.isRetryable(failureReason)) {
        this.logger.warn(`Заказ ${orderId} не будет повторяться. Причина: ${failureReason}`);
        return;
      }
      
      const now = new Date();
      
      // Создаём новый заказ для очереди
      const newOrder: FailedOrder = {
        orderId,
        userId,
        chatId,
        recipientUsername,
        starsCount,
        isGift,
        status: OrderStatus.PENDING,
        attempts: 1,
        maxAttempts: this.MAX_ATTEMPTS,
        failureReason,
        lastError,
        createdAt: now,
        lastAttemptAt: now,
        nextRetryAt: new Date(now.getTime() + this.RETRY_DELAY_MS),
        paymentMethod,
        paymentAmount,
        paymentCurrency,
        paymentTransactionId,
        isProcessing: false,
      };
      
      // Добавляем в очередь
      queue.push(newOrder);
      
      // Сохраняем
      await this.saveQueue(queue);
      
      this.logger.log(
        `➕ Заказ ${orderId} добавлен в очередь повторных попыток.\n` +
        `   Пользователь: @${recipientUsername}\n` +
        `   Звёзд: ${starsCount}\n` +
        `   Причина: ${failureReason}\n` +
        `   Следующая попытка: ${newOrder.nextRetryAt.toISOString()}`
      );
      
    } catch (error) {
      this.logger.error(`Ошибка при добавлении заказа в очередь:`, error);
    }
  }
  
  /**
   * Обрабатывает все заказы, готовые к повторной попытке
   */
  async processRetryQueue(): Promise<void> {
    try {
      const queue = await this.loadQueue();
      const now = new Date();
      let processedCount = 0;
      let successCount = 0;
      let failedCount = 0;
      
      this.logger.log(`\n${'='.repeat(60)}`);
      this.logger.log(`🔄 ОБРАБОТКА ОЧЕРЕДИ ПОВТОРНЫХ ПОПЫТОК`);
      this.logger.log(`   Всего заказов в очереди: ${queue.length}`);
      this.logger.log(`${'='.repeat(60)}\n`);
      
      for (const order of queue) {
        // Пропускаем уже завершённые или окончательно проваленные
        if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.FAILED) {
          continue;
        }
        
        // Пропускаем заказы, которые обрабатываются сейчас
        if (order.isProcessing) {
          continue;
        }
        
        // Проверяем, готов ли заказ к повторной попытке
        if (now < new Date(order.nextRetryAt)) {
          continue;
        }
        
        // Проверяем, не превышено ли количество попыток
        if (order.attempts >= order.maxAttempts) {
          order.status = OrderStatus.FAILED;
          failedCount++;
          this.logger.error(`❌ Заказ ${order.orderId} окончательно провален после ${order.attempts} попыток`);
          
          // Уведомляем пользователя
          await this.botService.notifyStarsPurchaseError(
            order.chatId,
            order.starsCount,
            order.isGift,
            `Не удалось выполнить заказ после ${order.attempts} попыток. Обратитесь в поддержку.`
          );
          continue;
        }
        
        // Обрабатываем заказ
        processedCount++;
        const result = await this.retryOrder(order);
        
        if (result.success) {
          successCount++;
        } else if (!result.shouldRetry) {
          failedCount++;
        }
      }
      
      // Сохраняем обновлённую очередь
      await this.saveQueue(queue);
      
      // Выводим статистику
      if (processedCount > 0) {
        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log(`📊 РЕЗУЛЬТАТЫ ОБРАБОТКИ ОЧЕРЕДИ:`);
        this.logger.log(`   Обработано заказов: ${processedCount}`);
        this.logger.log(`   ✅ Успешно: ${successCount}`);
        this.logger.log(`   ❌ Провалено: ${failedCount}`);
        this.logger.log(`   🔄 Будут повторены: ${processedCount - successCount - failedCount}`);
        this.logger.log(`${'='.repeat(60)}\n`);
      }
      
    } catch (error) {
      this.logger.error('Ошибка при обработке очереди:', error);
    }
  }
  
  /**
   * Пытается повторно обработать заказ
   */
  private async retryOrder(order: FailedOrder): Promise<RetryResult> {
    // Блокируем заказ
    order.isProcessing = true;
    order.processingStartedAt = new Date();
    order.status = OrderStatus.RETRYING;
    
    this.logger.log(
      `\n🔄 Попытка ${order.attempts + 1}/${order.maxAttempts} для заказа ${order.orderId}\n` +
      `   Пользователь: @${order.recipientUsername}\n` +
      `   Звёзд: ${order.starsCount}\n` +
      `   Последняя ошибка: ${order.lastError}`
    );
    
    try {
      // КРИТИЧЕСКАЯ ПРОВЕРКА: Не был ли заказ уже успешно выполнен?
      if (order.lastSuccessfulFragmentOrderId) {
        this.logger.warn(
          `⚠️ ДУБЛИКАТ ОБНАРУЖЕН! Заказ ${order.orderId} уже имеет успешный Fragment Order ID: ${order.lastSuccessfulFragmentOrderId}\n` +
          `   НЕ НАЧИСЛЯЕМ ЗВЁЗДЫ ПОВТОРНО!`
        );
        
        order.status = OrderStatus.COMPLETED;
        order.isProcessing = false;
        
        return {
          success: true,
          orderId: order.orderId,
          fragmentOrderId: order.lastSuccessfulFragmentOrderId,
          shouldRetry: false,
        };
      }
      
      // Пытаемся купить звёзды через Fragment API
      const fragmentOrder = await this.fragmentService.buyStars(
        order.recipientUsername,
        order.starsCount,
        false
      );
      
      // ✅ УСПЕХ! Сохраняем Fragment Order ID для защиты от дублирования
      order.lastSuccessfulFragmentOrderId = fragmentOrder.id;
      order.status = OrderStatus.COMPLETED;
      order.isProcessing = false;
      
      this.logger.log(
        `\n✅ УСПЕХ! Заказ ${order.orderId} выполнен успешно!\n` +
        `   Fragment Order ID: ${fragmentOrder.id}\n` +
        `   Пользователь: @${order.recipientUsername}\n` +
        `   Звёзд начислено: ${order.starsCount}\n` +
        `   Попыток потребовалось: ${order.attempts + 1}`
      );
      
      // Уведомляем пользователя об успехе
      await this.botService.notifyStarsPurchaseSuccess(
        order.chatId,
        order.starsCount,
        order.isGift,
        order.recipientUsername,
        fragmentOrder.id
      );
      
      // Удаляем информацию о заказе из BotService
      BotService.removeOrderInfo(order.orderId);
      
      return {
        success: true,
        orderId: order.orderId,
        fragmentOrderId: fragmentOrder.id,
        shouldRetry: false,
      };
      
    } catch (error: any) {
      // Ошибка при попытке
      order.attempts += 1;
      order.lastAttemptAt = new Date();
      order.lastError = error.message || 'Unknown error';
      order.isProcessing = false;
      order.processingStartedAt = undefined;
      
      // Классифицируем ошибку
      const failureReason = this.classifyError(error.message);
      order.failureReason = failureReason;
      
      this.logger.error(
        `❌ Попытка ${order.attempts}/${order.maxAttempts} провалена для заказа ${order.orderId}\n` +
        `   Ошибка: ${error.message}\n` +
        `   Тип ошибки: ${failureReason}`
      );
      
      // Проверяем, можно ли повторять
      const shouldRetry = 
        order.attempts < order.maxAttempts && 
        this.isRetryable(failureReason);
      
      if (shouldRetry) {
        // Планируем следующую попытку
        order.nextRetryAt = new Date(Date.now() + this.RETRY_DELAY_MS);
        order.status = OrderStatus.PENDING;
        
        this.logger.log(
          `   ⏰ Следующая попытка запланирована на: ${order.nextRetryAt.toISOString()}`
        );
      } else {
        // Окончательно провален
        order.status = OrderStatus.FAILED;
        
        this.logger.error(
          `   ❌ Заказ ${order.orderId} окончательно провален.\n` +
          `   Причина: ${failureReason}`
        );
        
        // Уведомляем пользователя
        await this.botService.notifyStarsPurchaseError(
          order.chatId,
          order.starsCount,
          order.isGift,
          `Заказ не может быть выполнен после ${order.attempts} попыток. Обратитесь в поддержку.`
        );
      }
      
      return {
        success: false,
        orderId: order.orderId,
        error: error.message,
        shouldRetry,
      };
    }
  }
  
  /**
   * Определяет, можно ли повторять заказ при данной причине ошибки
   */
  private isRetryable(reason: FailureReason): boolean {
    // НЕ повторяем, если пользователь не найден или недостаточно баланса
    const nonRetryableReasons = [
      FailureReason.FRAGMENT_USER_NOT_FOUND,
      FailureReason.FRAGMENT_INSUFFICIENT_BALANCE,
    ];
    
    return !nonRetryableReasons.includes(reason);
  }
  
  /**
   * Классифицирует ошибку по сообщению
   */
  private classifyError(errorMessage: string): FailureReason {
    const lowerError = errorMessage.toLowerCase();
    
    if (lowerError.includes('ssl') || lowerError.includes('tlsv1') || lowerError.includes('tlsv1_alert_internal_error')) {
      return FailureReason.FRAGMENT_SSL_ERROR;
    }
    
    if (lowerError.includes('timeout') || lowerError.includes('таймаут') || lowerError.includes('524')) {
      return FailureReason.FRAGMENT_TIMEOUT;
    }
    
    if (lowerError.includes('not found') || lowerError.includes('не найден')) {
      return FailureReason.FRAGMENT_USER_NOT_FOUND;
    }
    
    if (lowerError.includes('insufficient') || lowerError.includes('недостаточно')) {
      return FailureReason.FRAGMENT_INSUFFICIENT_BALANCE;
    }
    
    if (lowerError.includes('rate limit') || lowerError.includes('429')) {
      return FailureReason.FRAGMENT_RATE_LIMIT;
    }
    
    if (lowerError.includes('econnrefused') || lowerError.includes('enotfound') || lowerError.includes('unavailable')) {
      return FailureReason.FRAGMENT_UNAVAILABLE;
    }
    
    return FailureReason.UNKNOWN_ERROR;
  }
  
  /**
   * Загружает очередь из JSON файла
   */
  private async loadQueue(): Promise<FailedOrder[]> {
    try {
      const fileContent = await fs.readFile(this.queueFilePath, 'utf-8');
      const data: FailedOrder[] = JSON.parse(fileContent);
      
      // Восстанавливаем даты из строк
      for (const order of data) {
        order.createdAt = new Date(order.createdAt);
        order.lastAttemptAt = new Date(order.lastAttemptAt);
        order.nextRetryAt = new Date(order.nextRetryAt);
        if (order.processingStartedAt) {
          order.processingStartedAt = new Date(order.processingStartedAt);
        }
        
        // Сбрасываем флаг обработки при загрузке
        order.isProcessing = false;
        order.processingStartedAt = undefined;
      }
      
      return data;
      
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Файл не существует - возвращаем пустую очередь
        return [];
      }
      throw error;
    }
  }
  
  /**
   * Сохраняет очередь в JSON файл
   */
  private async saveQueue(queue: FailedOrder[]): Promise<void> {
    try {
      // Создаём директорию, если её нет
      const dir = path.dirname(this.queueFilePath);
      await fs.mkdir(dir, { recursive: true });
      
      // Сохраняем с красивым форматированием
      await fs.writeFile(
        this.queueFilePath, 
        JSON.stringify(queue, null, 2),
        'utf-8'
      );
      
      this.logger.debug(`Очередь сохранена: ${queue.length} заказов`);
      
    } catch (error) {
      this.logger.error('Ошибка при сохранении очереди:', error);
      throw error;
    }
  }
  
  /**
   * Получает статистику очереди
   */
  async getQueueStats(): Promise<{
    total: number;
    pending: number;
    retrying: number;
    completed: number;
    failed: number;
    processing: number;
  }> {
    const queue = await this.loadQueue();
    
    let pending = 0;
    let retrying = 0;
    let completed = 0;
    let failed = 0;
    let processing = 0;
    
    for (const order of queue) {
      switch (order.status) {
        case OrderStatus.PENDING:
          pending++;
          break;
        case OrderStatus.RETRYING:
          retrying++;
          break;
        case OrderStatus.COMPLETED:
          completed++;
          break;
        case OrderStatus.FAILED:
          failed++;
          break;
        case OrderStatus.PROCESSING:
          processing++;
          break;
      }
    }
    
    return {
      total: queue.length,
      pending,
      retrying,
      completed,
      failed,
      processing,
    };
  }
  
  /**
   * Очищает завершённые заказы старше N дней
   */
  async cleanupOldOrders(daysOld: number = 7): Promise<number> {
    const queue = await this.loadQueue();
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    
    const before = queue.length;
    const filteredQueue = queue.filter(order => {
      // Удаляем только завершённые и проваленные заказы старше cutoffDate
      if ((order.status === OrderStatus.COMPLETED || order.status === OrderStatus.FAILED)) {
        return new Date(order.lastAttemptAt) >= cutoffDate;
      }
      // Оставляем все остальные заказы
      return true;
    });
    
    const removed = before - filteredQueue.length;
    
    if (removed > 0) {
      await this.saveQueue(filteredQueue);
      this.logger.log(`Очищено ${removed} старых заказов из очереди`);
    }
    
    return removed;
  }
}
