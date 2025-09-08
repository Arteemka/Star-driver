import { Injectable } from '@nestjs/common';
import { writeFile, appendFile, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import { AppLogger } from '../../utils/logger';

const writeFileAsync = promisify(writeFile);
const appendFileAsync = promisify(appendFile);

export interface TransactionLog {
  timestamp: string;
  transactionId: string;
  orderId: string;
  status: 'PAID' | 'DECLINED' | 'PENDING' | 'ERROR' | 'PAYMENT_CREATED' | 'PAYMENT_FAILED' | 'WEBHOOK_SUCCESS' | 'WEBHOOK_FAILED';
  amount: number;
  currency: string;
  paymentMethod: string;
  userId?: number;
  username?: string;
  chatId?: number;
  starCount?: number;
  isGift?: boolean;
  giftRecipient?: string;
  errorCode?: string;
  errorDescription?: string;
  commission?: number;
  paymentTime?: string;
  fragmentOrderId?: string;
  processingError?: string;
  loggedAt?: string;
  paymentUrl?: string;
  webhookData?: any;
  operationType?: 'PAYMENT' | 'WEBHOOK';
}

@Injectable()
export class TransactionLoggerService {
  private readonly logger = AppLogger;
  private readonly logsDir = join(process.cwd(), 'logs');
  private readonly transactionsFile = join(this.logsDir, 'transactions.json');
  private readonly dailyLogFile = join(this.logsDir, `transactions-${new Date().toISOString().split('T')[0]}.log`);

  private readonly botLogFile = join(process.cwd(), 'bot.log');
  
  constructor() {
    this.ensureLogsDirectory();
  }

  /**
   * Убеждаемся что папка logs существует
   */
  private ensureLogsDirectory(): void {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
      this.logger.log(`Created logs directory: ${this.logsDir}`);
    }
  }

  /**
   * Логирует транзакцию в JSON файл и текстовый лог
   */
  async logTransaction(transaction: TransactionLog): Promise<void> {
    try {
      // Обогащаем данные транзакции
      const enrichedTransaction = {
        ...transaction,
        timestamp: new Date().toISOString(),
        loggedAt: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      };

      // 1. Логируем в консоль
      this.logToConsole(enrichedTransaction);

      // 2. Сохраняем в JSON файл
      await this.saveToJsonFile(enrichedTransaction);

      // 3. Добавляем в дневной текстовый лог
      await this.appendToDailyLog(enrichedTransaction);

      // 4. Добавляем в общий bot.log
      await this.appendToBotLog(enrichedTransaction);

      this.logger.log(`Transaction logged: ${transaction.transactionId}`);
    } catch (error) {
      this.logger.error('Failed to log transaction:', error);
    }
  }

  /**
   * Выводит красивый лог в консоль
   */
  private logToConsole(transaction: TransactionLog): void {
    const statusIcon = this.getStatusIcon(transaction.status);
    
    console.log('\n' + '='.repeat(80));
    console.log(`${statusIcon} ТРАНЗАКЦИЯ ${transaction.status} ${statusIcon}`);
    console.log('='.repeat(80));
    console.log(`🕒 Время: ${transaction.loggedAt}`);
    console.log(`🔢 ID транзакции: ${transaction.transactionId}`);
    console.log(`📦 ID заказа: ${transaction.orderId}`);
    console.log(`💰 Сумма: ${transaction.amount} ${transaction.currency}`);
    console.log(`💳 Способ оплаты: ${transaction.paymentMethod}`);
    
    if (transaction.userId) {
      console.log(`👤 User ID: ${transaction.userId}`);
    }
    
    if (transaction.username) {
      console.log(`👤 Username: @${transaction.username}`);
    }
    
    if (transaction.chatId) {
      console.log(`💬 Chat ID: ${transaction.chatId}`);
    }
    
    if (transaction.starCount) {
      console.log(`⭐ Количество звёзд: ${transaction.starCount}`);
    }
    
    if (transaction.isGift) {
      console.log(`🎁 Подарок: Да${transaction.giftRecipient ? ` для @${transaction.giftRecipient}` : ''}`);
    }
    
    if (transaction.commission) {
      console.log(`💸 Комиссия: ${transaction.commission} ${transaction.currency}`);
    }
    
    if (transaction.fragmentOrderId) {
      console.log(`🔗 Fragment Order ID: ${transaction.fragmentOrderId}`);
    }
    
    if (transaction.status === 'DECLINED' && (transaction.errorCode || transaction.errorDescription)) {
      console.log(`❌ Код ошибки: ${transaction.errorCode || 'N/A'}`);
      console.log(`❌ Описание ошибки: ${transaction.errorDescription || 'N/A'}`);
    }
    
    if (transaction.processingError) {
      console.log(`🚨 Ошибка обработки: ${transaction.processingError}`);
    }
    
    console.log('='.repeat(80));
  }

  /**
   * Возвращает иконку для статуса
   */
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'PAID':
        return '✅';
      case 'DECLINED':
        return '❌';
      case 'PENDING':
        return '⏳';
      case 'ERROR':
        return '🚨';
      case 'PAYMENT_CREATED':
        return '🆕';
      case 'PAYMENT_FAILED':
        return '💥';
      case 'WEBHOOK_SUCCESS':
        return '📨';
      case 'WEBHOOK_FAILED':
        return '📮';
      default:
        return '❓';
    }
  }


  /**
   * Сохраняет транзакцию в JSON файл
   */
  private async saveToJsonFile(transaction: TransactionLog): Promise<void> {
    try {
      let transactions: TransactionLog[] = [];

      // Читаем существующие транзакции
      if (existsSync(this.transactionsFile)) {
        const fs = require('fs');
        const data = fs.readFileSync(this.transactionsFile, 'utf8');
        if (data.trim()) {
          try {
            transactions = JSON.parse(data);
            // Валидация массива транзакций
            if (!Array.isArray(transactions)) {
              this.logger.warn('Invalid transactions format, resetting to empty array');
              transactions = [];
            }
          } catch (parseError) {
            this.logger.error('Failed to parse existing transactions JSON, creating backup:', parseError);
            // Создаём резервную копию повреждённого файла
            const backupFile = `${this.transactionsFile}.backup-${Date.now()}`;
            fs.copyFileSync(this.transactionsFile, backupFile);
            this.logger.log(`Backup created at: ${backupFile}`);
            transactions = [];
          }
        }
      }

      // Нормализуем данные транзакции (убираем undefined значения)
      const cleanTransaction = JSON.parse(JSON.stringify(transaction));
      
      // Добавляем новую транзакцию
      transactions.push(cleanTransaction);

      // Ограничиваем количество транзакций в файле (последние 1000)
      if (transactions.length > 1000) {
        transactions = transactions.slice(-1000);
      }

      // Сохраняем в файл
      await writeFileAsync(this.transactionsFile, JSON.stringify(transactions, null, 2), 'utf8');
    } catch (error) {
      this.logger.error('Failed to save to JSON file:', error);
    }
  }

  /**
   * Добавляет запись в дневной текстовый лог
   */
  private async appendToDailyLog(transaction: TransactionLog): Promise<void> {
    try {
      const logLine = this.formatLogLine(transaction);
      await appendFileAsync(this.dailyLogFile, logLine + '\n', 'utf8');
    } catch (error) {
      this.logger.error('Failed to append to daily log:', error);
    }
  }

  /**
   * Форматирует строку для текстового лога
   */
  private formatLogLine(transaction: TransactionLog): string {
    const parts = [
      transaction.timestamp,
      transaction.status,
      transaction.transactionId,
      transaction.orderId,
      `${transaction.amount} ${transaction.currency}`,
      transaction.paymentMethod,
    ];

    if (transaction.userId) {
      parts.push(`User:${transaction.userId}`);
    }

    if (transaction.username) {
      parts.push(`@${transaction.username}`);
    }

    if (transaction.starCount) {
      parts.push(`Stars:${transaction.starCount}`);
    }

    if (transaction.isGift && transaction.giftRecipient) {
      parts.push(`Gift:@${transaction.giftRecipient}`);
    }

    if (transaction.errorCode) {
      parts.push(`Error:${transaction.errorCode}`);
    }

    if (transaction.fragmentOrderId) {
      parts.push(`Fragment:${transaction.fragmentOrderId}`);
    }

    return parts.join(' | ');
  }

  /**
   * Добавляет запись в общий bot.log файл
   */
  private async appendToBotLog(transaction: TransactionLog): Promise<void> {
    try {
      const logLine = this.formatLogLine(transaction);
      await appendFileAsync(this.botLogFile, logLine + '\n', 'utf8');
    } catch (error) {
      this.logger.error('Failed to append to bot log:', error);
    }
  }

  /**
   * Получает статистику по транзакциям
   */
  async getTransactionStats(): Promise<{
    total: number;
    paid: number;
    declined: number;
    pending: number;
    error: number;
    totalAmount: number;
    totalStars: number;
  }> {
    try {
      if (!existsSync(this.transactionsFile)) {
        return {
          total: 0,
          paid: 0,
          declined: 0,
          pending: 0,
          error: 0,
          totalAmount: 0,
          totalStars: 0,
        };
      }

      const fs = require('fs');
      const data = fs.readFileSync(this.transactionsFile, 'utf8');
      if (!data.trim()) {
        return {
          total: 0,
          paid: 0,
          declined: 0,
          pending: 0,
          error: 0,
          totalAmount: 0,
          totalStars: 0,
        };
      }

      const transactions: TransactionLog[] = JSON.parse(data);
      
      const stats = transactions.reduce(
        (acc, t) => {
          acc.total++;
          switch (t.status) {
            case 'PAID':
              acc.paid++;
              acc.totalAmount += t.amount;
              acc.totalStars += t.starCount || 0;
              break;
            case 'DECLINED':
              acc.declined++;
              break;
            case 'PENDING':
              acc.pending++;
              break;
            case 'ERROR':
              acc.error++;
              break;
          }
          return acc;
        },
        {
          total: 0,
          paid: 0,
          declined: 0,
          pending: 0,
          error: 0,
          totalAmount: 0,
          totalStars: 0,
        }
      );

      return stats;
    } catch (error) {
      this.logger.error('Failed to get transaction stats:', error);
      return {
        total: 0,
        paid: 0,
        declined: 0,
        pending: 0,
        error: 0,
        totalAmount: 0,
        totalStars: 0,
      };
    }
  }

  /**
   * Логирует успешную транзакцию
   */
  async logSuccessfulTransaction(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    commission?: number;
    paymentTime?: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
    fragmentOrderId?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'PAID',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует неуспешную транзакцию
   */
  async logFailedTransaction(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    errorCode?: string;
    errorDescription?: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'DECLINED',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует ошибку обработки транзакции
   */
  async logProcessingError(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    processingError: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'ERROR',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует успешное создание платежа
   */
  async logPaymentCreated(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    paymentUrl?: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'PAYMENT_CREATED',
      operationType: 'PAYMENT',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует неудачное создание платежа
   */
  async logPaymentCreationFailed(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    errorCode?: string;
    errorDescription?: string;
    processingError?: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'PAYMENT_FAILED',
      operationType: 'PAYMENT',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует успешную обработку webhook
   */
  async logWebhookSuccess(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    webhookData?: any;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
    fragmentOrderId?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'WEBHOOK_SUCCESS',
      operationType: 'WEBHOOK',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Логирует неудачную обработку webhook
   */
  async logWebhookFailed(data: {
    transactionId: string;
    orderId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    webhookData?: any;
    errorCode?: string;
    errorDescription?: string;
    processingError?: string;
    userId?: number;
    username?: string;
    chatId?: number;
    starCount?: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<void> {
    await this.logTransaction({
      ...data,
      status: 'WEBHOOK_FAILED',
      operationType: 'WEBHOOK',
      timestamp: new Date().toISOString(),
    });
  }
}
