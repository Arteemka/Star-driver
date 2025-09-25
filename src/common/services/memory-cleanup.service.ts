import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppLogger } from '../../utils/logger';
import { TransactionLoggerService } from './transaction-logger.service';
import { BotService } from '../../bot/bot.service';

/**
 * Сервис для автоматической очистки памяти от старых транзакций
 * Запускается при старте и затем каждые 12 часов
 */
@Injectable()
export class MemoryCleanupService implements OnModuleInit {
  private readonly logger = AppLogger;
  
  constructor(
    private readonly transactionLogger: TransactionLoggerService,
  ) {
    this.logger.log('MemoryCleanupService initialized');
  }

  async onModuleInit() {
    this.logger.log('🚀 Starting initial memory cleanup on startup...');
    // Выполняем первую очистку при запуске
    await this.performMemoryCleanup();
  }

  /**
   * Выполняет очистку памяти каждые 12 часов
   * Cron запускается в 00:00 и 12:00
   */
  @Cron('0 0,12 * * *')
  async scheduledCleanup(): Promise<void> {
    this.logger.log('⏰ Starting scheduled memory cleanup (every 12 hours)...');
    await this.performMemoryCleanup();
  }

  /**
   * Основной метод очистки памяти
   * Удаляет первую половину накопленных транзакций, оставляя последние
   */
  async performMemoryCleanup(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('🧹 === MEMORY CLEANUP STARTED ===');
    
    try {
      // Получаем начальное использование памяти
      const memBefore = process.memoryUsage();
      const heapUsedMB = Math.round(memBefore.heapUsed / 1024 / 1024);
      const rssMB = Math.round(memBefore.rss / 1024 / 1024);
      
      this.logger.log(`📊 Memory before cleanup: Heap=${heapUsedMB}MB, RSS=${rssMB}MB`);
      
      // 1. Очищаем транзакции в TransactionLoggerService
      const transactionsCleared = await this.transactionLogger.clearOldTransactionsFromMemory();
      this.logger.log(`✅ Cleared ${transactionsCleared} old transactions from memory`);
      
      // 2. Очищаем старые заказы в BotService
      const ordersCleared = BotService.clearOldOrders();
      this.logger.log(`✅ Cleared ${ordersCleared} old orders from BotService`);
      
      // 3. Очищаем старые webhook записи
      const webhooksCleared = await this.clearOldWebhooks();
      this.logger.log(`✅ Cleared ${webhooksCleared} old webhook records`);
      
      // Принудительный запуск сборщика мусора (если доступен)
      if (global.gc) {
        global.gc();
        this.logger.log('♻️ Forced garbage collection');
      }
      
      // Получаем использование памяти после очистки
      const memAfter = process.memoryUsage();
      const heapAfterMB = Math.round(memAfter.heapUsed / 1024 / 1024);
      const rssAfterMB = Math.round(memAfter.rss / 1024 / 1024);
      
      const heapFreed = heapUsedMB - heapAfterMB;
      const rssFreed = rssMB - rssAfterMB;
      const duration = Date.now() - startTime;
      
      this.logger.log(`📊 Memory after cleanup: Heap=${heapAfterMB}MB, RSS=${rssAfterMB}MB`);
      this.logger.log(`🎯 Memory freed: Heap=${heapFreed}MB, RSS=${rssFreed}MB`);
      this.logger.log(`⏱️ Cleanup completed in ${duration}ms`);
      
      // Выводим итоговую статистику
      this.logger.log('📈 Cleanup Summary:');
      this.logger.log(`   - Transactions cleared: ${transactionsCleared}`);
      this.logger.log(`   - Orders cleared: ${ordersCleared}`);
      this.logger.log(`   - Webhooks cleared: ${webhooksCleared}`);
      this.logger.log(`   - Total memory freed: ${heapFreed + rssFreed}MB`);
      
      this.logger.log('🧹 === MEMORY CLEANUP COMPLETED ===');
      
    } catch (error) {
      this.logger.error('❌ Error during memory cleanup:', error);
    }
  }

  /**
   * Очищает старые webhook записи
   * Импортируем динамически чтобы избежать циклических зависимостей
   */
  private async clearOldWebhooks(): Promise<number> {
    try {
      // Динамический импорт для избежания циклических зависимостей
      const { KassaWebhookService } = await import('../../payments/kassa-webhook.service');
      
      let totalCleared = 0;
      
      // Очищаем webhook записи в KassaWebhookService если у него есть такой метод
      // Примечание: метод clearOldWebhooks должен быть статическим в KassaWebhookService
      if (typeof (KassaWebhookService as any).clearOldWebhooks === 'function') {
        totalCleared += (KassaWebhookService as any).clearOldWebhooks();
      }
      
      // Если нужно добавить другие webhook сервисы в будущем, можно добавить их здесь:
      // const { PayID19WebhookService } = await import('../../payments/payid19-webhook.service');
      // const { WataWebhookService } = await import('../../payments/wata-webhook.service');
      
      return totalCleared;
    } catch (error) {
      this.logger.warn('Could not clear webhooks:', error);
      return 0;
    }
  }

  /**
   * Возвращает текущую статистику использования памяти
   */
  getMemoryStats(): {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    externalMB: number;
    heapUsedPercent: number;
  } {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const externalMB = Math.round(mem.external / 1024 / 1024);
    const heapUsedPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    
    return {
      heapUsedMB,
      heapTotalMB,
      rssMB,
      externalMB,
      heapUsedPercent,
    };
  }

  /**
   * Принудительная очистка памяти (можно вызвать вручную)
   */
  async forceCleanup(): Promise<void> {
    this.logger.log('⚡ Forcing immediate memory cleanup...');
    await this.performMemoryCleanup();
  }
}
