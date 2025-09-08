import { Injectable, Logger } from '@nestjs/common';
import { WataWebhookPayload } from './wata-webhook.controller';
import { BotService } from '../bot/bot.service';
import { FragmentService } from './fragment.service';
import { TransactionLoggerService } from '../common/services/transaction-logger.service';

@Injectable()
export class WataWebhookService {
  private readonly logger = new Logger(WataWebhookService.name);

  constructor(
    private readonly fragmentService: FragmentService,
    private readonly botService: BotService,
    private readonly transactionLogger: TransactionLoggerService,
  ) {}

  /**
   * Проверяет подпись webhook'а от WATA (устаревший метод)
   * @deprecated Используйте WataSignatureService вместо этого
   * @param _rawBody Сырое тело запроса в формате JSON string
   * @param _signature Подпись из заголовка X-Signature
   */
  async verifySignature(_rawBody: string, _signature: string): Promise<boolean> {
    // Устаревший метод, всегда возвращает true для обратной совместимости
    this.logger.warn('Using deprecated verifySignature method. Use WataSignatureService instead.');
    return true;
  }

  /**
   * Обрабатывает webhook уведомление от WATA
   */
  async processWebhook(payload: WataWebhookPayload): Promise<void> {
    this.logger.log(`Processing WATA webhook for order: ${payload.orderId}`);

    // Выводим информацию о платеже в консоль
    console.log('🔔 WATA PAYMENT UPDATE 🔔');
    console.log(`Order ID: ${payload.orderId}`);
    console.log(`Transaction ID: ${payload.transactionId}`);
    console.log(`Status: ${payload.transactionStatus}`);
    console.log(`Amount: ${payload.amount} ${payload.currency}`);
    console.log(`Payment Type: ${payload.transactionType}`);
    console.log(`Payment Time: ${payload.paymentTime}`);
    
    if (payload.transactionStatus === 'Paid') {
      console.log('✅ PAYMENT SUCCESSFUL!');
      console.log(`Commission: ${payload.commission}`);
      
      // Здесь можно добавить логику для успешного платежа
      await this.handleSuccessfulPayment(payload);
    } else if (payload.transactionStatus === 'Declined') {
      console.log('❌ PAYMENT FAILED!');
      console.log(`Error Code: ${payload.errorCode}`);
      console.log(`Error Description: ${payload.errorDescription}`);
      
      // Здесь можно добавить логику для неуспешного платежа
      await this.handleFailedPayment(payload);
    }
    
    console.log('================================');
  }

  /**
   * Обрабатывает успешный платеж
   */
  private async handleSuccessfulPayment(payload: WataWebhookPayload): Promise<void> {
    this.logger.log(`Successful payment processing for order: ${payload.orderId}`);
    
    // Получаем информацию о заказе из сессии бота
    const orderInfo = BotService.getOrderInfo(payload.orderId);
    
    if (!orderInfo) {
      console.log(`⚠️ Не найдена информация о заказе: ${payload.orderId}`);
      this.logger.warn(`Order info not found for ${payload.orderId}`);
      return;
    }

    // Логируем детали платежа с информацией о Telegram пользователе
    console.log(`✅ Order ${payload.orderId} has been paid successfully!`);
    console.log(`💰 Amount: ${payload.amount} ${payload.currency}`);
    console.log(`🕒 Time: ${payload.paymentTime}`);
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
        transactionId: payload.transactionId,
        orderId: payload.orderId,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: payload.transactionType || 'WATA',
        commission: payload.commission,
        paymentTime: payload.paymentTime,
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
        transactionId: payload.transactionId + '_webhook',
        orderId: payload.orderId,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: 'WATA',
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
      BotService.removeOrderInfo(payload.orderId);
      
    } catch (error) {
      console.log(`❌ Ошибка при покупке звёзд через Fragment API:`, error);
      this.logger.error(`Failed to buy stars for order ${payload.orderId}:`, error);
      
      // Пытаемся получить username для ошибки
      let errorUsername: string | null = null;
      if (orderInfo.isGift && orderInfo.giftUsername) {
        errorUsername = orderInfo.giftUsername;
      } else {
        errorUsername = await this.getUsernameById(orderInfo.userId);
      }
      
      // Логируем ошибку обработки транзакции
      await this.transactionLogger.logProcessingError({
        transactionId: payload.transactionId,
        orderId: payload.orderId,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: payload.transactionType || 'WATA',
        processingError: (error as Error)?.message || 'Неизвестная ошибка при покупке звёзд',
        userId: orderInfo.userId,
        username: errorUsername || undefined,
        chatId: orderInfo.chatId,
        starCount: orderInfo.count,
        isGift: orderInfo.isGift,
        giftRecipient: orderInfo.giftUsername,
      });
      
      // Логируем неудачный webhook
      await this.transactionLogger.logWebhookFailed({
        transactionId: payload.transactionId + '_webhook_error',
        orderId: payload.orderId,
        amount: payload.amount,
        currency: payload.currency,
        paymentMethod: 'WATA',
        webhookData: payload,
        errorDescription: 'Failed to process stars purchase',
        processingError: (error as Error)?.message || 'Неизвестная ошибка',
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
   * Обрабатывает неуспешный платеж
   */
  private async handleFailedPayment(payload: WataWebhookPayload): Promise<void> {
    this.logger.log(`Failed payment processing for order: ${payload.orderId}`);
    
    // Получаем информацию о заказе для логирования
    const orderInfo = BotService.getOrderInfo(payload.orderId);
    
    // Пытаемся получить username для неуспешной транзакции
    let failedUsername: string | null = null;
    if (orderInfo) {
      if (orderInfo.isGift && orderInfo.giftUsername) {
        failedUsername = orderInfo.giftUsername;
      } else {
        failedUsername = await this.getUsernameById(orderInfo.userId);
      }
    }
    
    // Логируем неуспешную транзакцию
    await this.transactionLogger.logFailedTransaction({
      transactionId: payload.transactionId,
      orderId: payload.orderId,
      amount: payload.amount,
      currency: payload.currency,
      paymentMethod: payload.transactionType || 'WATA',
      errorCode: payload.errorCode,
      errorDescription: payload.errorDescription,
      userId: orderInfo?.userId,
      username: failedUsername || undefined,
      chatId: orderInfo?.chatId,
      starCount: orderInfo?.count,
      isGift: orderInfo?.isGift,
      giftRecipient: orderInfo?.giftUsername,
    });
    
    // Пример уведомления в консоль
    console.log(`❌ Payment failed for order ${payload.orderId}`);
    console.log(`💸 Failed amount: ${payload.amount} ${payload.currency}`);
    console.log(`📋 Error: ${payload.errorCode} - ${payload.errorDescription}`);
    
    // Опционально: уведомляем пользователя о неуспешном платеже
    if (orderInfo) {
      try {
        await this.botService.notifyStarsPurchaseError(
          orderInfo.chatId,
          orderInfo.count,
          orderInfo.isGift,
          `Платёж отклонён: ${payload.errorDescription || 'Неизвестная ошибка'}`
        );
      } catch (notificationError) {
        this.logger.error('Failed to send payment failure notification:', notificationError);
      }
      
      // Удаляем информацию о заказе
      BotService.removeOrderInfo(payload.orderId);
    }
  }
}
