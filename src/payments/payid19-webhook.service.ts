import { Injectable, Logger } from '@nestjs/common';
import { PayID19WebhookData, PayID19Service } from './payid19.service';
import { BotService } from '../bot/bot.service';
import { FragmentService } from './fragment.service';
import { TransactionLoggerService } from '../common/services/transaction-logger.service';

@Injectable()
export class PayID19WebhookService {
  private readonly logger = new Logger(PayID19WebhookService.name);

  constructor(
    private readonly payid19Service: PayID19Service,
    private readonly fragmentService: FragmentService,
    private readonly botService: BotService,
    private readonly transactionLogger: TransactionLoggerService,
  ) {}

  /**
   * Проверяет валидность webhook'а от PayID19
   */
  async validateWebhook(payload: PayID19WebhookData): Promise<boolean> {
    return this.payid19Service.validateWebhook(payload);
  }

  /**
   * Обрабатывает webhook уведомление от PayID19
   */
  async processWebhook(payload: PayID19WebhookData): Promise<void> {
    this.logger.log(`Processing PayID19 webhook for order: ${payload.order_id}`);

    // Выводим информацию о платеже в консоль
    console.log('🔔 PAYID19 PAYMENT UPDATE 🔔');
    console.log(`Order ID: ${payload.order_id}`);
    console.log(`Invoice ID: ${payload.id}`);
    if (payload.price_amount && payload.price_currency) {
      console.log(`Price Amount: ${payload.price_amount} ${payload.price_currency}`);
    }
    if (payload.amount && payload.amount_currency) {
      console.log(`Actual Amount: ${payload.amount} ${payload.amount_currency}`);
    }
    console.log(`Test Mode: ${payload.test === 1 ? 'YES' : 'NO'}`);
    if (payload.created_at) {
      console.log(`Created At: ${payload.created_at}`);
    }
    if (payload.ip) {
      console.log(`IP: ${payload.ip}`);
    }
    
    // PayID19 отправляет webhook только при успешной оплате
    console.log('✅ CRYPTO PAYMENT SUCCESSFUL!');
    
    // Проверяем наличие order_id
    if (!payload.order_id) {
      console.log('⚠️ Missing order_id in webhook payload, cannot process');
      this.logger.warn('Missing order_id in PayID19 webhook payload');
      return;
    }
    
    // Обрабатываем успешный платеж
    await this.handleSuccessfulPayment(payload);
    
    console.log('================================');
  }

  /**
   * Обрабатывает успешный криптоплатеж
   */
  private async handleSuccessfulPayment(payload: PayID19WebhookData): Promise<void> {
    this.logger.log(`Successful crypto payment processing for order: ${payload.order_id}`);
    
    // Получаем информацию о заказе из сессии бота
    const orderInfo = BotService.getOrderInfo(payload.order_id || '');
    
    if (!orderInfo) {
      console.log(`⚠️ Не найдена информация о заказе: ${payload.order_id}`);
      this.logger.warn(`Order info not found for ${payload.order_id}`);
      return;
    }

    // Логируем детали платежа с информацией о Telegram пользователе
    console.log(`✅ Order ${payload.order_id} has been paid with cryptocurrency!`);
    console.log(`💰 Price: ${payload.price_amount} ${payload.price_currency}`);
    console.log(`🪙 Received: ${payload.amount} ${payload.amount_currency}`);
    console.log(`👤 Telegram User ID: ${orderInfo.userId}`);
    console.log(`💬 Chat ID: ${orderInfo.chatId}`);
    console.log(`⭐ Stars to buy: ${orderInfo.count}`);
    console.log(`🎁 Is Gift: ${orderInfo.isGift}`);
    if (orderInfo.isGift && orderInfo.giftUsername) {
      console.log(`🎯 Gift Recipient: @${orderInfo.giftUsername}`);
    }

    try {
      // Пытаемся извлечь username из description webhook'а
      let recipientUsername: string | null = null;
      
      if (payload.description) {
        const match = payload.description.match(/recipient:([^\s|]+)/);
        if (match) {
          recipientUsername = match[1];
          console.log(`🎯 Username извлечён из webhook: @${recipientUsername}`);
        }
      }
      
      // Если не удалось извлечь, пытаемся получить из сохранённых данных заказа
      if (!recipientUsername) {
        console.log('⚠️ Не удалось извлечь username из webhook, используем данные заказа...');
        
        if (orderInfo.isGift && orderInfo.giftUsername) {
          // Подарок - покупаем для получателя
          recipientUsername = orderInfo.giftUsername;
        } else {
          // Покупка для себя - пытаемся получить username покупателя
          const username = await this.getUsernameById(orderInfo.userId);
          if (!username) {
            console.log(`⚠️ Не удалось получить username для пользователя ${orderInfo.userId}, используем fallback`);
            recipientUsername = `user_${orderInfo.userId}`;
          } else {
            recipientUsername = username;
            console.log(`👤 Username получен: @${recipientUsername}`);
          }
        }
      }
      
      if (!recipientUsername) {
        console.log(`❌ Не удалось определить username получателя`);
        throw new Error('Не удалось определить username получателя');
      }

      console.log(`🚀 Покупаем ${orderInfo.count} звёзд для @${recipientUsername} через Fragment API...`);
      
      // Покупаем звёзды через Fragment API
      const fragmentOrder = await this.fragmentService.buyStars(
        recipientUsername,
        orderInfo.count,
        false 
      );

      console.log(`✨ Fragment заказ создан: ${fragmentOrder.id}`);
      console.log(`🎯 Получатель: @${fragmentOrder.username}`);
      console.log(`⭐ Количество: ${fragmentOrder.goods_quantity}`);
      console.log(`💰 Стоимость в TON: ${fragmentOrder.ton_price}`);
      
      if (orderInfo.isGift) {
        console.log(`🎁 Подарок ${orderInfo.count} звёзд успешно отправлен @${recipientUsername}!`);
      } else {
        console.log(`✅ ${orderInfo.count} звёзд успешно начислено пользователю!`);
      }

      // Логируем успешную транзакцию
      await this.transactionLogger.logSuccessfulTransaction({
        transactionId: payload.id,
        orderId: payload.order_id || '',
        amount: payload.price_amount,
        currency: payload.price_currency,
        paymentMethod: 'PayID19-Crypto',
        paymentTime: payload.created_at,
        userId: orderInfo.userId,
        username: recipientUsername,
        chatId: orderInfo.chatId,
        starCount: orderInfo.count,
        isGift: orderInfo.isGift,
        giftRecipient: orderInfo.giftUsername,
        fragmentOrderId: fragmentOrder.id,
      });

      // Отправляем уведомление пользователю в Telegram
      await this.botService.notifyStarsPurchaseSuccess(
        orderInfo.chatId,
        orderInfo.count,
        orderInfo.isGift,
        recipientUsername,
        fragmentOrder.id
      );

      // Логируем успешный webhook
      await this.transactionLogger.logWebhookSuccess({
        transactionId: payload.id + '_webhook',
        orderId: payload.order_id || '',
        amount: payload.price_amount,
        currency: payload.price_currency,
        paymentMethod: 'PayID19',
        webhookData: payload,
        userId: orderInfo.userId,
        username: recipientUsername,
        chatId: orderInfo.chatId,
        starCount: orderInfo.count,
        isGift: orderInfo.isGift,
        giftRecipient: orderInfo.giftUsername,
        fragmentOrderId: fragmentOrder.id
      });

      // Удаляем информацию о заказе после успешной обработки
      BotService.removeOrderInfo(payload.order_id || '');
      
    } catch (error) {
      console.log(`❌ Ошибка при покупке звёзд через Fragment API:`, error);
      this.logger.error(`Failed to buy stars for order ${payload.order_id}:`, error);
      
      // Логируем ошибку обработки транзакции
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка при покупке звёзд';
      
      // Пытаемся получить username для ошибки
      let errorUsername: string | null = null;
      if (orderInfo.isGift && orderInfo.giftUsername) {
        errorUsername = orderInfo.giftUsername;
      } else {
        errorUsername = await this.getUsernameById(orderInfo.userId);
      }
      
      await this.transactionLogger.logProcessingError({
        transactionId: payload.id,
        orderId: payload.order_id || '',
        amount: payload.price_amount,
        currency: payload.price_currency,
        paymentMethod: 'PayID19-Crypto',
        processingError: errorMessage,
        userId: orderInfo.userId,
        username: errorUsername || undefined,
        chatId: orderInfo.chatId,
        starCount: orderInfo.count,
        isGift: orderInfo.isGift,
        giftRecipient: orderInfo.giftUsername,
      });
      
      // Логируем неудачный webhook
      await this.transactionLogger.logWebhookFailed({
        transactionId: payload.id + '_webhook_error',
        orderId: payload.order_id || '',
        amount: payload.price_amount,
        currency: payload.price_currency,
        paymentMethod: 'PayID19',
        webhookData: payload,
        errorDescription: 'Failed to process stars purchase',
        processingError: errorMessage,
        userId: orderInfo.userId,
        username: errorUsername || undefined,
        chatId: orderInfo.chatId,
        starCount: orderInfo.count,
        isGift: orderInfo.isGift,
        giftRecipient: orderInfo.giftUsername
      });
      
      // Отправляем уведомление пользователю об ошибке
      await this.botService.notifyStarsPurchaseError(
        orderInfo.chatId,
        orderInfo.count,
        orderInfo.isGift,
        errorMessage
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
}
