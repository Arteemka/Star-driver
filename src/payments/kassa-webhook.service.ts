import { Injectable, Logger } from '@nestjs/common';
import { KassaWebhookPayload } from './kassa-webhook.controller';
import { BotService } from '../bot/bot.service';
import { FragmentService } from './fragment.service';
import { TransactionLoggerService } from '../common/services/transaction-logger.service';

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
      // Определяем, кому покупать звёзды
      let recipientUsername: string;
      
      if (orderInfo.isGift && orderInfo.giftUsername) {
        // Подарок - покупаем для получателя
        recipientUsername = orderInfo.giftUsername;
      } else {
        // Покупка для себя - пытаемся получить username покупателя
        recipientUsername = (await this.getUsernameById(orderInfo.userId)) || `user_${orderInfo.userId}`;
        if (!recipientUsername) {
          console.log(`⚠️ Не удалось получить username для пользователя ${orderInfo.userId}, используем fallback`);
          recipientUsername = `user_${orderInfo.userId}`;
        } else {
          console.log(`👤 Username получен: @${recipientUsername}`);
        }
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
      console.log(`❌ Ошибка при покупке звёзд через Fragment API:`, error);
      this.logger.error(`Failed to buy stars for order ${payload.order_id}:`, error);
      
      // Отправляем уведомление пользователю об ошибке
      await this.botService.notifyStarsPurchaseError(
        orderInfo.chatId,
        orderInfo.count,
        orderInfo.isGift,
        (error as Error)?.message || 'Неизвестная ошибка'
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
}
