import { Injectable } from '@nestjs/common';
import { Telegram } from 'telegraf';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MIN_STARS, START_CAPTION, STAR_PRICE_RUB, STAR_PRICE_USD, Currency } from '../common/constants/star.constants';
import {
  CallbackData,
  PaymentMethod,
} from '../common/constants/payment.constants';
import { WataService } from '../payments/wata.service';
import { PayID19Service } from '../payments/payid19.service';
import { FragmentService } from '../payments/fragment.service';
import { KassaService } from '../payments/kassa.service';
import { TransactionLoggerService } from '../common/services/transaction-logger.service';
import { Markup } from 'telegraf';
import { AppLogger } from '../utils/logger';

// Сессия пользователя для диалогов
interface SessionData {
  flow: 'buy' | 'gift';
  step: number;
  username?: string;
  count?: number;
}

// Информация о заказе для webhook'ов
export interface OrderInfo {
  chatId: number;
  userId: number;
  count: number;
  isGift: boolean;
  giftUsername?: string;
  description: string;
  timestamp: string;
}

@Injectable()
export class BotService {
  private readonly tg: Telegram;
  private readonly logger = AppLogger;
  private readonly session = new Map<number, SessionData>();
  
  // Постоянное Reply-меню
  private readonly mainKeyboard = Markup.keyboard([
    ['⭐ Купить Звёзды'],
    ['🎁 Сделать Подарок Другу'],
    ['Поддержка'],
  ]).resize().oneTime(false);

  constructor(
    private readonly config: ConfigService,
    private readonly wataService: WataService,
    private readonly payid19Service: PayID19Service,
    private readonly kassaService: KassaService,
    private readonly fragmentService: FragmentService,
    private readonly transactionLogger: TransactionLoggerService,
  ) {
    const token = this.config.getOrThrow<string>('TELEGRAM_TOKEN');
    this.tg = new Telegram(token);
    this.logger.log('Telegram client initialized');
  }

  /** Обработка команды /start */
  async handleStart(chatId: number): Promise<void> {
    this.session.delete(chatId);
    const bannerUrl = this.config.getOrThrow<string>('BANNER_URL');
    try {
      await this.tg.sendPhoto(chatId, bannerUrl, {
        caption: START_CAPTION,
        reply_markup: {
          inline_keyboard: [
            [{ text: '⭐ Купить Звёзды', callback_data: CallbackData.BUY }],
            [
              {
                text: '🎁 Сделать Подарок Другу',
                callback_data: CallbackData.GIFT,
              },
            ],
          ],
        },
      });
      
     
      
      this.logger.log(`/start handled for chat ${chatId}`);
    } catch (err) {
      this.logger.error(`handleStart failed for chat ${chatId}`, err as Error);
      await this.tg.sendMessage(chatId, START_CAPTION, {
        reply_markup: this.mainKeyboard.reply_markup
      });
    }
  }

  /** Обработка нажатия inline-кнопок */
  async handleCallback(
    queryId: string,
    data: CallbackData,
    userId: number,
  ): Promise<void> {
    await this.tg.answerCbQuery(queryId).catch(() => {});
    let session: SessionData;
    switch (data) {
      case CallbackData.BUY:
        // Проверяем наличие username перед покупкой
        const hasBuyUsername = await this.checkAndRequireUsername(userId, 'покупки звёзд');
        if (!hasBuyUsername) {
          return; // Пользователю отправлено сообщение о необходимости установить username
        }
        session = { flow: 'buy', step: 1 };
        this.session.set(userId, session);
        await this.askCount(userId);
        return;
      case CallbackData.GIFT:
        // Проверяем наличие username перед отправкой подарка
        const hasGiftUsername = await this.checkAndRequireUsername(userId, 'отправки подарка');
        if (!hasGiftUsername) {
          return; // Пользователю отправлено сообщение о необходимости установить username
        }
        session = { flow: 'gift', step: 1 };
        this.session.set(userId, session);
        await this.askUsername(userId);
        return;
      case CallbackData.SUPPORT:
        await this.handleSupport(userId);
        return;
      default:
        await this.tg.sendMessage(
          userId,
          'Неизвестная команда. Нажмите /start.',
          { reply_markup: this.mainKeyboard.reply_markup }
        );
        return;
    }
  }

  /** Обработка любого текстового сообщения */
  async handleMessage(chatId: number, text: string): Promise<void> {
    const session = this.session.get(chatId);
    if (!session) {
      await this.tg.sendMessage(chatId, 'Нажмите /start, чтобы начать.', {
        reply_markup: this.mainKeyboard.reply_markup
      });
      return;
    }
    if (session.flow === 'buy') {
      await this.processBuyFlow(chatId, text, session);
    } else {
      await this.processGiftFlow(chatId, text, session);
    }
  }

  /** Шаг 1: запрашиваем количество звёзд */
  private async askCount(chatId: number): Promise<void> {
    await this.tg.sendMessage(
      chatId,
      `🌟 Введите нужное количество звёзд (минимум ${MIN_STARS}):`,
      { reply_markup: this.mainKeyboard.reply_markup }
    );
  }

  /** Шаг 1 (подарок): запрашиваем username получателя */
  private async askUsername(chatId: number): Promise<void> {
    await this.tg.sendMessage(chatId, 'Введите @username получателя:', {
      reply_markup: this.mainKeyboard.reply_markup
    });
  }

  /** Обрабатываем поток покупки */
  private async processBuyFlow(
    chatId: number,
    text: string,
    session: SessionData,
  ): Promise<void> {
    if (session.step === 1) {
      const count = Number(text);
      if (isNaN(count) || count < MIN_STARS) {
        await this.tg.sendMessage(
          chatId,
          `❌ Введите корректное число (минимум ${MIN_STARS}).`,
          { reply_markup: this.mainKeyboard.reply_markup }
        );
        return;
      }

      // Проверяем баланс Fragment перед предложением оплаты
      const balanceCheckResult = await this.checkFragmentBalance(count);
      if (!balanceCheckResult.sufficient) {
        await this.tg.sendMessage(
          chatId,
          
          `🔄 Попробуйте указать меньшее количество звёзд или обратитесь в техническую поддержку.`
        );
        return;
      }

      session.count = count;
      session.step = 2;
      await this.sendPaymentOptionsWithDetails(chatId, count, false);
      return;
    }
    // шаг 2: выбор оплаты
    const method = text as PaymentMethod;
    await this.processPayment(chatId, method, session, false);
  }

  /** Обрабатываем поток подарка */
  private async processGiftFlow(
    chatId: number,
    text: string,
    session: SessionData,
  ): Promise<void> {
    if (session.step === 1) {
      session.username = text.trim().replace(/^@/, '');
      session.step = 2;
      await this.askCount(chatId);
      return;
    }
    if (session.step === 2) {
      const count = Number(text);
      if (isNaN(count) || count < MIN_STARS) {
        await this.tg.sendMessage(
          chatId,
          `❌ Введите корректное число (минимум ${MIN_STARS}).`,
          { reply_markup: this.mainKeyboard.reply_markup }
        );
        return;
      }

      // Проверяем баланс Fragment перед предложением оплаты
      const balanceCheckResult = await this.checkFragmentBalance(count);
      if (!balanceCheckResult.sufficient) {
        await this.tg.sendMessage(
          chatId,
         
          `🔄 Попробуйте указать меньшее количество звёзд или обратитесь в техническую поддержку.`
        );
        return;
      }

      session.count = count;
      session.step = 3;
      await this.sendPaymentOptionsWithDetails(chatId, count, true, session.username);
      return;
    }
    // шаг 3: выбор оплаты
    const method = text as PaymentMethod;
    await this.processPayment(chatId, method, session, true);
  }



  /** Отправляем детали заказа с inline-кнопками для оплаты */
  private async sendPaymentOptionsWithDetails(
    chatId: number, 
    count: number, 
    isGift: boolean, 
    giftUsername?: string
  ): Promise<void> {
    try {
      // Генерируем уникальный orderId
      const timestamp = Date.now();
      const randomId = randomUUID().replace(/-/g, '').substring(0, 8);
      const microseconds = process.hrtime.bigint() % 1000000n;
      const orderId = `${timestamp}_${chatId}_${randomId}_${microseconds}`;
      
      const description = isGift 
        ? `Подарок ${count} звезд для @${giftUsername}` 
        : `Покупка ${count} звезд`;
      
      // Сохраняем информацию о заказе
      this.saveOrderInfo(orderId, {
        chatId,
        userId: chatId,
        count,
        isGift,
        giftUsername,
        description,
        timestamp: new Date().toISOString(),
      });

      // Рассчитываем стоимости
      const cryptoAmount = count * STAR_PRICE_USD; // USD для крипто
      const cardAmount = count * STAR_PRICE_RUB; // RUB для карт/СБП вата сервис не позволяет меньше ста рублей

      // Определяем username получателя для PayID19
      let recipientUsername: string;
      if (isGift && giftUsername) {
        recipientUsername = giftUsername;
      } else {
        const userInfo = await this.getUserInfo(chatId);
        recipientUsername = userInfo?.username || `user_${chatId}`;
      }

      // Создаем ссылки на оплату
      const enhancedDescription = `${description} | recipient:${recipientUsername}`;
      
      try {
        // Используем тот же orderId для всех платежных систем        
        const [cryptoInvoiceUrl, cardPaymentLink, kassaPayment] = await Promise.all([
          this.payid19Service.createInvoice(
            cryptoAmount,
            'USD',
            enhancedDescription,
            orderId,
            undefined
          ),
          this.wataService.createPaymentLink(
            cardAmount,
            Currency.RUB,
            description,
            orderId
          ),
          this.kassaService.createPayment(
            cardAmount,
            orderId,

          )
        ]);

        // Логируем успешное создание платежей
        await this.transactionLogger.logPaymentCreated({
          transactionId: orderId + '_crypto',
          orderId,
          amount: cryptoAmount,
          currency: 'USD',
          paymentMethod: 'PayID19',
          paymentUrl: cryptoInvoiceUrl,
          userId: chatId,
          username: recipientUsername,
          chatId,
          starCount: count,
          isGift,
          giftRecipient: giftUsername
        });

        await this.transactionLogger.logPaymentCreated({
          transactionId: orderId + '_wata',
          orderId,
          amount: cardAmount,
          currency: 'RUB',
          paymentMethod: 'WATA',
          paymentUrl: cardPaymentLink.url,
          userId: chatId,
          username: recipientUsername,
          chatId,
          starCount: count,
          isGift,
          giftRecipient: giftUsername
        });

        await this.transactionLogger.logPaymentCreated({
          transactionId: orderId + '_p2pkassa',
          orderId: orderId,
          amount: cardAmount,
          currency: 'RUB',
          paymentMethod: 'P2PKassa',
          userId: chatId,
          username: recipientUsername,
          chatId,
          starCount: count,
          isGift,
          giftRecipient: giftUsername
        });

        // Формируем сообщение с деталями заказа
        const orderDetails = `📋 **Детали заказа:**\n` +
          `• Заказ: \`${orderId}\`\n` +
          `• Звёзд: **${count}**\n` +
          `${isGift ? `• Получатель: **@${giftUsername}**\n` : ''}\n` +
          '⏰ **Срок оплаты: 30 минут**\n\n' +
          '⏳ Нажмите на одну из кнопок выше для перехода к оплате\n' +
          'После успешной оплаты звёзды будут автоматически начислены\n' +
          'Вы получите уведомление о завершении операции\n\n' +
          `💳 **Выберите способ оплаты:**`;

        // Создаем inline-кнопки
        const inlineKeyboard = [
          [{
            text: `💰 Криптовалюта (${Number(cryptoAmount.toFixed(2))} USD)`,
            url: cryptoInvoiceUrl
          }],
          [{
            text: `💳 Карта/СБП WATA (${cardAmount} RUB)`,
            url: cardPaymentLink.url || '#'
          }],
          [{
            text: `💳 Карта/СБП Kassa (${cardAmount} RUB)`,
            url: kassaPayment.link || '#'
          }]
        ];

        await this.tg.sendMessage(chatId, orderDetails, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: inlineKeyboard,
            remove_keyboard: true
          }
        });   

        this.logger.log(`Payment options with details sent for order ${orderId}`);
        
        // Удаляем сессию, так как теперь всё управляется через webhook
        this.session.delete(chatId);
        
      } catch (paymentError) {
        this.logger.error('Failed to create payments:', paymentError);
        
        // Логируем ошибку создания платежей
        await this.transactionLogger.logPaymentCreationFailed({
          transactionId: orderId + '_failed',
          orderId,
          amount: cryptoAmount,
          currency: 'USD',
          paymentMethod: 'MULTIPLE',
          errorDescription: 'Failed to create payment links',
          processingError: paymentError instanceof Error ? paymentError.message : 'Unknown payment error',
          userId: chatId,
          username: recipientUsername,
          chatId,
          starCount: count,
          isGift,
          giftRecipient: giftUsername
        });
        
        throw paymentError; // Переброс ошибки для обработки в общем catch
      }
      
    } catch (error) {
      this.logger.error('Failed to create payment options with details:', error);
      await this.tg.sendMessage(
        chatId,
        '❗ Произошла ошибка при создании платежей. Попробуйте позже.',
        { reply_markup: this.mainKeyboard.reply_markup }
      );
      this.session.delete(chatId);
    }
  }

  /** Общая обработка оплаты (моки) */
  private async processPayment(
    chatId: number,
    choice: PaymentMethod,
    session: SessionData,
    isGift: boolean,
  ): Promise<void> {
    const count = session.count!;
    // Генерируем супер уникальный orderId
    const timestamp = Date.now();
    const randomId = randomUUID().replace(/-/g, '').substring(0, 8); // 8 символов из UUID
    const microseconds = process.hrtime.bigint() % 1000000n; // Микросекунды для доп. уникальности
    const orderId = `${timestamp}_${chatId}_${randomId}_${microseconds}`;
    const description = isGift 
      ? `Подарок ${count} звезд для @${session.username}` 
      : `Покупка ${count} звезд`;
    
    // Сохраняем информацию о заказе для webhook'а
    this.saveOrderInfo(orderId, {
      chatId,
      userId: chatId,
      count,
      isGift,
      giftUsername: session.username,
      description,
      timestamp: new Date().toISOString(),
    });
    
    switch (choice) {
      case PaymentMethod.CRYPTO: {
        try {
          // Определяем username получателя для передачи в PayID19
          let recipientUsername: string;
          if (isGift && session.username) {
            recipientUsername = session.username;
          } else {
            // Для покупки себе пытаемся получить username покупателя
            const userInfo = await this.getUserInfo(chatId);
            recipientUsername = userInfo?.username || `user_${chatId}`;
          }
          
          // Создаем инвойс через PayID19 для криптоплатежей
          const amount = count * STAR_PRICE_USD; // Стоимость звёзд в USD
          const enhancedDescription = `${description} | recipient:${recipientUsername}`;
          
          const invoiceUrl = await this.payid19Service.createInvoice(
            amount,
            'USD',
            enhancedDescription,
            orderId,
            undefined, // email не требуется
          );
          
          // Получаем форматированный список поддерживаемых криптовалют
          const supportedCryptos = this.payid19Service.getFormattedCryptocurrencies();
          
          // Форматируем сообщение без специальных символов Markdown
          const message = `💰 Оплата криптовалютой\n\n` +
            `🚀 Ссылка для оплаты:\n${invoiceUrl}\n\n` +
            `📋 Детали заказа:\n` +
            `• Заказ: ${orderId}\n` +
            `• Сумма: ${Number(amount.toFixed(2))} USD\n` +
            `• Звёзд: ${count}\n\n` +
            `🪙 Поддерживаемые криптовалюты:\n` +
            `${supportedCryptos}\n\n` +
            `⏰ Срок оплаты: 1 час\n` +
            `🔒 Безопасный платеж через PayID19`;
          
          await this.tg.sendMessage(chatId, message, {
            reply_markup: this.mainKeyboard.reply_markup
          });
          
          this.logger.log(`PayID19 invoice created for order ${orderId}: ${invoiceUrl}`);
        } catch (error) {
          this.logger.error('PayID19 payment creation failed', error);
          await this.tg.sendMessage(
            chatId,
            '❗ Произошла ошибка при создании криптоплатежа. Попробуйте позже.',
            { reply_markup: this.mainKeyboard.reply_markup }
          );
          this.session.delete(chatId);
          return;
        }
        break;
      }
      case PaymentMethod.SBP: {
        try {
          // Создаем платежную ссылку через WATA API
          const amount = count * STAR_PRICE_RUB; // Стоимость звёзд в рублях
          const paymentLink = await this.wataService.createPaymentLink(
            amount,
            Currency.RUB,
            description,
            orderId
          );
          
          if (paymentLink.url) {
            const message = `💳 Оплата картой/СБП\n\n` +
              `🚀 Ссылка для оплаты:\n${paymentLink.url}\n\n` +
              `📋 Детали заказа:\n` +
              `• Заказ: ${orderId}\n` +
              `• Сумма: ${amount} ${paymentLink.currency}\n` +
              `• Звёзд: ${count}\n\n` +
              `⏰ Срок оплаты: до завершения сессии\n` +
              `🔒 Безопасный платеж через WATA`;
            
            await this.tg.sendMessage(chatId, message, {
              reply_markup: this.mainKeyboard.reply_markup
            });
            
            this.logger.log(`Payment link created for order ${orderId}: ${paymentLink.url}`);
          } else {
            await this.tg.sendMessage(
              chatId,
              '❗ Не удалось создать ссылку на оплату. Попробуйте позже.',
              { reply_markup: this.mainKeyboard.reply_markup }
            );
            this.session.delete(chatId);
          }
        } catch (error) {
          this.logger.error('Payment creation failed', error);
          await this.tg.sendMessage(
            chatId,
            '❗ Произошла ошибка при создании платежа. Попробуйте позже.',
            { reply_markup: this.mainKeyboard.reply_markup }
          );
          this.session.delete(chatId);
          return;
        }
        break;
      }
      default:
        await this.tg.sendMessage(chatId, '❗ Выберите способ оплаты из меню.', {
          reply_markup: this.mainKeyboard.reply_markup
        });
        this.session.delete(chatId);
        return;
    }

    // Добавляем информационное сообщение о том, что ожидаем оплату
    await this.tg.sendMessage(
      chatId, 
      '⏳ Ожидаем оплату...\n\n' +
      'После успешной оплаты звёзды будут автоматически начислены.\n' +
      'Вы получите уведомление о завершении операции.',
      { reply_markup: this.mainKeyboard.reply_markup }
    );
    
    // Сессию не удаляем - она будет удалена в webhook после обработки
  }

  // Статическое хранилище заказов (в реальном проекте лучше использовать базу данных)
  private static readonly orders = new Map<string, OrderInfo>();

  /**
   * Сохраняет информацию о заказе для последующего использования в webhook'ах
   */
  saveOrderInfo(orderId: string, orderInfo: OrderInfo): void {
    BotService.orders.set(orderId, orderInfo);
    this.logger.log(`Order info saved: ${orderId} for user ${orderInfo.chatId}`);
  }

  /**
   * Получает информацию о заказе по его ID
   */
  static getOrderInfo(orderId: string): OrderInfo | undefined {
    return BotService.orders.get(orderId);
  }

  /**
   * Удаляет информацию о заказе после обработки
   */
  static removeOrderInfo(orderId: string): void {
    BotService.orders.delete(orderId);
  }

  /**
   * Получает информацию о пользователе Telegram
   */
  async getUserInfo(userId: number): Promise<{ username?: string; first_name?: string; last_name?: string } | null> {
    try {
      const chat = await this.tg.getChat(userId);
      if (chat.type === 'private') {
        return {
          username: (chat as any).username,
          first_name: (chat as any).first_name,
          last_name: (chat as any).last_name,
        };
      }
      return null;
    } catch (error) {
      this.logger.warn(`Failed to get user info for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Отправляет уведомление пользователю о успешной покупке звёзд
   */
  async notifyStarsPurchaseSuccess(
    chatId: number,
    count: number,
    isGift: boolean,
    recipientUsername?: string,
    fragmentOrderId?: string
  ): Promise<void> {
    try {
      let message: string;
      
      if (isGift && recipientUsername) {
        message = `🎉 **Подарок отправлен!**\n\n` +
                 `⭐ **${count} звёзд** успешно подарено пользователю **@${recipientUsername}**\n\n` +
                 `✅ Платёж обработан\n\n`;
        if (fragmentOrderId) {
          message += `📋 Fragment Order ID: \`${fragmentOrderId}\`\n\n`;
        }
        message += `✅ **Операция завершена!**\n` +
                  `🌟 Спасибо за использование нашего сервиса!`;
      } else {
        message = `✅ **Покупка завершена!**\n\n` +
                 `⭐ **${count} звёзд** успешно начислено на ваш аккаунт\n\n` +
                 `💰 Платёж обработан\n\n`;
        if (fragmentOrderId) {
          message += `📋 Fragment Order ID: \`${fragmentOrderId}\`\n\n`;
        }
        message += `✅ **Операция завершена!**\n` +
                  `🌟 Спасибо за покупку!`;
      }

      await this.tg.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: this.mainKeyboard.reply_markup
      });
      
      this.logger.log(`Success notification sent to chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to send success notification to chat ${chatId}:`, error);
    }
  }

  /**
   * Отправляет уведомление пользователю об ошибке покупки звёзд
   */
  async notifyStarsPurchaseError(
    chatId: number,
    count: number,
    isGift: boolean,
    _errorMessage: string
  ): Promise<void> {
    try {
      const message = `❌ **Ошибка при покупке звёзд**\n\n` +
                     `Не удалось ${isGift ? 'отправить подарок' : 'начислить звёзды'}\n` +
                     `Количество: ${count} звёзд\n\n` +
                     `🔄 Мы уже работаем над решением проблемы\n` +
                     `💬 Обратитесь в поддержку, если проблема повторится`;

      await this.tg.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: this.mainKeyboard.reply_markup
      });
      
      this.logger.log(`Error notification sent to chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to send error notification to chat ${chatId}:`, error);
    }
  }

  /**
   * Проверяет достаточность средств на Fragment балансе для покупки звёзд
   * @param starsCount Количество звёзд
   * @returns Результат проверки баланса
   */
  private async checkFragmentBalance(starsCount: number): Promise<{
    sufficient: boolean;
    availableTon: string;
    requiredTon: number;
  }> {
    try {
      this.logger.log(`Checking Fragment balance for ${starsCount} stars`);
      
      // Получаем баланс кошелька
      const walletBalance = await this.fragmentService.getWalletBalance();
      
      const availableTonNum = parseFloat(walletBalance.balance);
      
      // Рассчитываем необходимые средства
      const requiredTon = this.fragmentService.calculateStarsCostInTon(starsCount);
      
      const sufficient = availableTonNum >= requiredTon;
      
      this.logger.log(`Balance check result: available=${availableTonNum} TON, required=${requiredTon} TON, sufficient=${sufficient}`);
      
      return {
        sufficient,
        availableTon: walletBalance.balance,
        requiredTon,
      };
    } catch (error) {
      this.logger.error('Failed to check Fragment balance:', error);
      
      // В случае ошибки считаем, что средств недостаточно
      // и показываем просьбу обратиться в поддержку
      const requiredTon = this.fragmentService.calculateStarsCostInTon(starsCount);
      
      return {
        sufficient: false,
        availableTon: 'недоступно',
        requiredTon,
      };
    }
  }

  /** Обработка запроса поддержки */
  async handleSupport(chatId: number): Promise<void> {
    try {
      await this.tg.sendMessage(
        chatId,
        '💬 **Поддержка**\n\n' +
        'Обратитесь в нашу техническую поддержку для помощи:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{
                text: '💬 Поддержка @Purple13s',
                url: 'https://t.me/Purple13s'
              }]
            ]
          }
        }
      );
      this.logger.log(`Support message sent to chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to send support message to chat ${chatId}:`, error);
    }
  }

  /**
   * Проверяет наличие username у пользователя и требует его установки, если он отсутствует
   * @param userId ID пользователя
   * @param action Действие, для которого требуется username
   * @returns true если username есть, false если нет
   */
  private async checkAndRequireUsername(userId: number, action: string): Promise<boolean> {
    try {
      const userInfo = await this.getUserInfo(userId);
      
      // Проверяем наличие username
      if (!userInfo?.username) {
        // Отправляем сообщение с инструкцией по установке username
        const message = `❗ **Требуется имя пользователя**\n\n` +
          `Для ${action} необходимо установить имя пользователя в Telegram.\n\n` +
          `📝 **Как установить имя пользователя:**\n` +
          `1. Откройте настройки Telegram\n` +
          `2. Нажмите «Изменить профиль» или «Edit Profile»\n` +
          `3. В поле «Имя пользователя» введите уникальное имя\n` +
          `4. Сохраните изменения\n\n` +
          `✅ После установки имени пользователя нажмите /start и попробуйте снова.\n\n` +
          `❓ Если нужна помощь, обратитесь в поддержку.`;
        
        await this.tg.sendMessage(userId, message, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{
                text: '💬 Поддержка',
                url: 'https://t.me/Purple13s'
              }],
              [{
                text: '🔄 Проверить еще раз',
                callback_data: CallbackData.BUY // Или GIFT в зависимости от action
              }]
            ]
          }
        });
        
        this.logger.log(`User ${userId} requires username for ${action}`);
        return false;
      }
      
      this.logger.log(`User ${userId} has username: @${userInfo.username}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to check username for user ${userId}:`, error);
      
      // В случае ошибки отправляем общее сообщение
      await this.tg.sendMessage(
        userId,
        '❗ Произошла ошибка при проверке профиля. Пожалуйста, убедитесь, что у вас установлено имя пользователя и попробуйте снова.',
        { reply_markup: this.mainKeyboard.reply_markup }
      );
      
      return false;
    }
  }

}
