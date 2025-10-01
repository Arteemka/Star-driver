import { Injectable, Logger } from '@nestjs/common';
import { KassaWebhookPayload } from './kassa-webhook.controller';
import { BotService } from '../bot/bot.service';
import { FragmentService } from './fragment.service';
import { TransactionLoggerService } from '../common/services/transaction-logger.service';
import { RetryQueueService } from './retry-queue.service';
import { FailureReason } from './retry-queue.interface';

@Injectable()
export class KassaWebhookService {
  private readonly logger = new Logger(KassaWebhookService.name);
  
  // Хранилище обработанных webhook'ов для защиты от дублирования
  private static readonly processedWebhooks = new Map<string, { timestamp: number; orderId: string }>();
  
  // Время жизни записи о обработанном webhook (1 час в миллисекундах)
  private static readonly WEBHOOK_TTL = 60 * 60 * 1000;

  constructor(
    private readonly fragmentService: FragmentService,
    private readonly botService: BotService,
    private readonly transactionLogger: TransactionLoggerService,
    private readonly retryQueueService: RetryQueueService,
  ) {}

  /**
   * Обрабатывает webhook уведомление от Kassa
   */
  async processWebhook(payload: KassaWebhookPayload): Promise<void> {
    this.logger.log(`Processing Kassa webhook for order: ${payload.order_id}`);

    // Проверяем на дублирование webhook запроса
    const webhookKey = `${payload.id}_${payload.order_id}`;
    if (this.isWebhookAlreadyProcessed(webhookKey)) {
      console.log(`⚠️ Обнаружен дублированный webhook запрос: ${webhookKey}`);
      this.logger.warn(`Duplicate webhook detected: ${webhookKey}. Skipping processing.`);
      return;
    }

    // Выводим информацию о платеже в консоль
    console.log('🔔 KASSA PAYMENT UPDATE 🔔');
    console.log(`Order ID: ${payload.order_id}`);
    console.log(`Payment ID: ${payload.id}`);
    console.log(`Project ID: ${payload.project_id}`);
    console.log(`Original Amount: ${payload.amount} ${payload.currency}`);
    console.log(`Paid Amount: ${payload.amount_pay} ${payload.currency_pay}`);
    console.log(`Created: ${payload.createDateTime}`);
    
    // Определяем статус платежа (в P2PKassa webhook приходит только при успешной оплате)
    console.log('✅ PAYMENT SUCCESSFUL!');
    
    try {
      // Помечаем webhook как обработанный
      this.markWebhookAsProcessed(webhookKey, payload.order_id);
      
      // Обрабатываем успешный платеж
      await this.handleSuccessfulPayment(payload);
      
      // Логируем успешную обработку webhook
      await this.transactionLogger.logWebhookSuccess({
        transactionId: payload.id,
        orderId: payload.order_id,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: 'P2PKassa',
        webhookData: payload,
      });
      
    } catch (error) {
      this.logger.error(`Error processing webhook ${webhookKey}:`, error);
      
      // Логируем ошибку webhook
      await this.transactionLogger.logWebhookFailed({
        transactionId: payload.id,
        orderId: payload.order_id,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: 'P2PKassa',
        webhookData: payload,
        processingError: error instanceof Error ? error.message : 'Unknown error',
      });
      
      // Удаляем запись о обработанном webhook при ошибке
      KassaWebhookService.processedWebhooks.delete(webhookKey);
      
      throw error;
    }
    
    console.log('================================');
  }

  /**
   * Обрабатывает успешный платеж
   */
  private async handleSuccessfulPayment(payload: KassaWebhookPayload): Promise<void> {
    this.logger.log(`Successful payment processing for order: ${payload.order_id}`);
    
    // Получаем информацию о заказе из сессии бота
    const orderInfo = BotService.getOrderInfo(payload.order_id);
    
    if (!orderInfo) {
      console.log(`⚠️ Не найдена информация о заказе: ${payload.order_id}`);
      this.logger.warn(`Order info not found for ${payload.order_id}`);
      return;
    }
    
    // Логируем ПОЛНУЮ информацию о найденном заказе
    console.log('📋 ПОЛНАЯ ИНФОРМАЦИЯ О ЗАКАЗЕ:');
    console.log(`🔢 Order ID: ${payload.order_id}`);
    console.log(`👤 User ID: ${orderInfo.userId}`);
    console.log(`💬 Chat ID: ${orderInfo.chatId}`);
    console.log(`⭐ Stars Count: ${orderInfo.count}`);
    console.log(`🎁 Is Gift: ${orderInfo.isGift}`);
    if (orderInfo.isGift && orderInfo.giftUsername) {
      console.log(`🎯 Gift Recipient: @${orderInfo.giftUsername}`);
    }
    console.log(`📝 Description: ${orderInfo.description}`);
    console.log(`🕒 Order Timestamp: ${orderInfo.timestamp}`);
    console.log('================================');
    

    // Логируем детали платежа с информацией о Telegram пользователе
    console.log(`✅ Order ${payload.order_id} has been paid successfully!`);
    console.log(`💰 Amount: ${payload.amount} ${payload.currency}`);
    console.log(`💳 Paid: ${payload.amount_pay} ${payload.currency_pay}`);
    console.log(`🕒 Time: ${payload.createDateTime}`);
    console.log(`👤 Telegram User ID: ${orderInfo.userId}`);
    console.log(`💬 Chat ID: ${orderInfo.chatId}`);
    console.log(`⭐ Stars to buy: ${orderInfo.count}`);
    console.log(`🎁 Is Gift: ${orderInfo.isGift}`);
    if (orderInfo.isGift && orderInfo.giftUsername) {
      console.log(`🎯 Gift Recipient: @${orderInfo.giftUsername}`);
    }

    try {
      // Определяем получателя звёзд напрямую из данных заказа
      let recipientUsername: string;
      
      if (orderInfo.isGift && orderInfo.giftUsername) {
        // Подарок - используем username получателя из заказа
        recipientUsername = orderInfo.giftUsername;
        console.log(`🎁 Подарок для: @${recipientUsername}`);
      } else {
        // Покупка для себя - получаем username покупателя
        const username = await this.getUsernameById(orderInfo.userId);
        if (!username) {
          console.log(`❌ Не удалось получить username для пользователя ${orderInfo.userId}`);
          throw new Error(`Не удалось получить username для пользователя ${orderInfo.userId}`);
        }
        recipientUsername = username;
        console.log(`👤 Покупка для себя: @${recipientUsername}`);
      }

      console.log(`🚀 Покупаем ${orderInfo.count} звёзд для @${recipientUsername} через Fragment API...`);
      
      // Покупаем звёзды через Fragment API
      const fragmentOrder = await this.fragmentService.buyStars(
        recipientUsername,
        orderInfo.count,
        false
      );

      // ПОЛНОЕ логирование Fragment заказа
      console.log('\n🌟 === ПОЛНАЯ ИНФОРМАЦИЯ О FRAGMENT ЗАКАЗЕ ===');
      console.log(`📋 Full Fragment API Response:`);
      console.log(JSON.stringify(fragmentOrder, null, 2));
      console.log('\n📊 ДЕТАЛИ FRAGMENT ЗАКАЗА:');
      console.log(`✨ Fragment Order ID: ${fragmentOrder.id}`);
      console.log(`🎯 Получатель (receiver): ${fragmentOrder.receiver}`);
      console.log(`👤 Username: ${fragmentOrder.username}`);
      console.log(`⭐ Количество звёзд (goods_quantity): ${fragmentOrder.goods_quantity}`);
      console.log(`💰 Стоимость в TON (ton_price): ${fragmentOrder.ton_price}`);
      console.log(`🔗 Reference ID (ref_id): ${fragmentOrder.ref_id}`);
      console.log(`✅ Success Status: ${fragmentOrder.success}`);
      if (fragmentOrder.sender) {
        console.log(`📞 Sender Phone: ${fragmentOrder.sender.phone_number}`);
        console.log(`👤 Sender Name: ${fragmentOrder.sender.name}`);
      }
      console.log('=============================================\n');
      
      if (orderInfo.isGift) {
        console.log(`🎁 Подарок ${orderInfo.count} звёзд успешно отправлен @${recipientUsername}!`);
      } else {
        console.log(`✅ ${orderInfo.count} звёзд успешно начислено пользователю!`);
      }

      // Отправляем уведомление пользователю в Telegram
      await this.botService.notifyStarsPurchaseSuccess(
        orderInfo.chatId,
        orderInfo.count,
        orderInfo.isGift,
        recipientUsername,
        fragmentOrder.id
      );

      // Удаляем информацию о заказе после успешной обработки
      BotService.removeOrderInfo(payload.order_id);
      
    } catch (error) {
      console.log(`❗ Ошибка при покупке звёзд через Fragment API:`, error);
      this.logger.error(`Failed to buy stars for order ${payload.order_id}:`, error);
      
      // Определяем тип ошибки
      const errorMessage = (error as Error)?.message || 'Неизвестная ошибка';
      
      this.logger.log(`🔎 Analyzing error type for order ${payload.order_id}: ${errorMessage}`);
      
      // Классифицируем ошибку для определения стратегии
      const failureReason = this.classifyFailureReason(errorMessage);
      
      // Специальная обработка для USER_NOT_FOUND - не добавляем в очередь
      if (failureReason === FailureReason.FRAGMENT_USER_NOT_FOUND) {
        this.logger.warn(`🚫 Processing USER_NOT_FOUND error for order ${payload.order_id}, user: @${recipientUsername}`);
        await this.handleUserNotFoundError(orderInfo, recipientUsername);
        return; // НЕ добавляем в очередь повторных попыток
      }
      
      // ✅ ДОБАВЛЯЕМ ЗАКАЗ В ОЧЕРЕДЬ ПОВТОРНЫХ ПОПЫТОК
      this.logger.log(`➕ Добавляем заказ ${payload.order_id} в очередь повторных попыток`);
      
      await this.retryQueueService.addFailedOrder(
        payload.order_id,
        orderInfo.userId,
        orderInfo.chatId,
        recipientUsername,
        orderInfo.count,
        orderInfo.isGift,
        failureReason,
        errorMessage,
        'P2PKassa',
        payload.amount,
        payload.currency,
        payload.id
      );
      
      // Отправляем пользователю уведомление о том, что будет повторная попытка
      await this.botService['tg'].sendMessage(
        orderInfo.chatId,
        `⏳ **Временная ошибка при обработке заказа**\n\n` +
        `Платёж успешно получен, но возникла проблема с Fragment API.\n\n` +
        `🔄 **Мы автоматически повторим попытку через 2 минуты.**\n` +
        `Всего будет сделано до 10 попыток.\n\n` +
        `Вы получите уведомление, когда звёзды будут начислены.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Получает username пользователя по его Telegram ID
   */
  private async getUsernameById(userId: number): Promise<string | null> {
    try {
      if (this.botService) {
        const userInfo = await this.botService.getUserInfo(userId);
        return userInfo?.username || null;
      }
      return null;
    } catch (error) {
      this.logger.warn(`Failed to get username for user ${userId}:`, error);
      return null;
    }
  }
  
  /**
   * Проверяет, был ли webhook уже обработан
   */
  private isWebhookAlreadyProcessed(webhookKey: string): boolean {
    this.cleanupExpiredWebhooks();
    return KassaWebhookService.processedWebhooks.has(webhookKey);
  }
  
  /**
   * Помечает webhook как обработанный
   */
  private markWebhookAsProcessed(webhookKey: string, orderId: string): void {
    KassaWebhookService.processedWebhooks.set(webhookKey, {
      timestamp: Date.now(),
      orderId,
    });
    this.logger.log(`Webhook marked as processed: ${webhookKey}`);
  }
  
  /**
   * Очищает устаревшие записи о обработанных webhook'ах
   */
  private cleanupExpiredWebhooks(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, data] of KassaWebhookService.processedWebhooks.entries()) {
      if (now - data.timestamp > KassaWebhookService.WEBHOOK_TTL) {
        expiredKeys.push(key);
      }
    }
    
    expiredKeys.forEach(key => {
      KassaWebhookService.processedWebhooks.delete(key);
      this.logger.debug(`Cleaned up expired webhook record: ${key}`);
    });
    
    if (expiredKeys.length > 0) {
      this.logger.log(`Cleaned up ${expiredKeys.length} expired webhook records`);
    }
  }

  /**
   * Обрабатывает ошибку "user not found"
   */
  private async handleUserNotFoundError(
    orderInfo: any,
    recipientUsername: string
  ): Promise<void> {
    this.logger.log(`🚫 Starting USER_NOT_FOUND error handling for user @${recipientUsername}, order: ${orderInfo.orderId || 'N/A'}, chat: ${orderInfo.chatId}`);
    
    const message = `❌ **Пользователь не найден в Fragment**\n\n` +
      `Пользователь @${recipientUsername} не найден на платформе Fragment.\n\n` +
      `🔗 **Что нужно сделать:**\n` +
      `1. Перейдите на Fragment: https://fragment.com\n` +
      `2. Зарегистрируйтесь или войдите в аккаунт\n` +
      `3. Обратитесь в поддержку для возврата средств\n\n` +
      `💰 Платёж обработан, но звёзды не могут быть начислены.\n` +
      `Мы поможем вам с возвратом.`;

    this.logger.log(`📨 Sending USER_NOT_FOUND notification to chat ${orderInfo.chatId} for user @${recipientUsername}`);

    try {
      await this.botService['tg'].sendMessage(orderInfo.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{
              text: '🌐 Перейти на Fragment',
              url: 'https://fragment.com'
            }],
            [{
              text: '💬 Обратиться в поддержку',
              url: 'https://t.me/Purple13s'
            }]
          ]
        }
      });
      
      this.logger.log(`✅ USER_NOT_FOUND error notification sent successfully to chat ${orderInfo.chatId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to send USER_NOT_FOUND notification to chat ${orderInfo.chatId}:`, error);
    }
  }

  /**
   * Классифицирует ошибку для определения причины и стратегии повтора
   */
  private classifyFailureReason(errorMessage: string): FailureReason {
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
}
