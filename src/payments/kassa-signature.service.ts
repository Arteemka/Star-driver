import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * Сервис для проверки подписи webhook уведомлений от Kassa API
 */
@Injectable()
export class KassaSignatureService {
  private readonly logger = new Logger(KassaSignatureService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.getOrThrow<string>('KASSA_API_KEY');
  }

  /**
   * Проверяет подпись webhook'а от Kassa
   * Подпись считается по алгоритму: SHA256(apikey + id + order_id + project_id + amount + currency)
   * @param payload Данные webhook'а от Kassa
   */
  async verifyWebhookSignature(payload: any): Promise<boolean> {
    try {
      const { id, order_id, project_id, amount, currency, sign } = payload;

      // Проверяем наличие всех необходимых полей
      if (!id || !order_id || !project_id || !amount || !currency || !sign) {
        this.logger.error('Missing required fields for signature verification', {
          hasId: !!id,
          hasOrderId: !!order_id,
          hasProjectId: !!project_id,
          hasAmount: !!amount,
          hasCurrency: !!currency,
          hasSign: !!sign,
        });
        return false;
      }

      // Создаем строку для подписи по схеме P2PKassa (SHA256)
      // Формат: apikey + id + order_id + project_id + amount + currency
      // Используем тот же формат, что и при создании платежа
      const stringToSign = this.apiKey + id + order_id + `${project_id}` + `${parseFloat(amount).toFixed(2)}` + currency;

      // Вычисляем SHA256 хеш
      const expectedSign = createHash('sha256')
        .update(stringToSign)
        .digest('hex');

      // Сравниваем подписи (без учета регистра)
      const isValid = expectedSign.toLowerCase() === sign.toLowerCase();

      this.logger.log(`Kassa webhook signature verification: ${isValid ? 'VALID' : 'INVALID'}`);

      if (!isValid) {
        this.logger.debug('Signature verification failed');
        this.logger.debug(`Expected: ${expectedSign}`);
        this.logger.debug(`Received: ${sign}`);
        this.logger.debug(`String to sign: ${stringToSign.substring(0, 50)}...`); // Показываем только начало для безопасности
        this.logger.debug(`Payment ID: ${id}`);
        this.logger.debug(`Order ID: ${order_id}`);
        this.logger.debug(`Project ID: ${project_id}`);
        this.logger.debug(`Amount: ${amount}`);
        this.logger.debug(`Currency: ${currency}`);
      }

      return isValid;
    } catch (error) {
      this.logger.error('Error verifying Kassa webhook signature:', error);
      return false;
    }
  }

  /**
   * Создает подпись для исходящих запросов к Kassa API
   * Алгоритм: SHA512(apikey + order_id + project_id + amount + 'RUB')
   */
  createApiSignature(orderId: string, projectId: string, amount: number): string {
    const signatureString = `${this.apiKey}${orderId}${projectId}${amount}RUB`;
    const hash = createHash('sha512').update(signatureString).digest('hex');
    this.logger.debug(`API signature created for order ${orderId}`);
    return hash;
  }

  /**
   * Валидирует структуру webhook payload от Kassa
   */
  validateWebhookPayload(payload: any): boolean {
    const requiredFields = ['id', 'order_id', 'project_id', 'amount', 'currency', 'sign'];
    
    for (const field of requiredFields) {
      if (payload[field] === undefined || payload[field] === null) {
        this.logger.error(`Missing required field in Kassa webhook payload: ${field}`);
        return false;
      }
    }

    // Проверяем типы данных
    if (typeof payload.amount !== 'number' || payload.amount <= 0) {
      this.logger.error('Invalid amount in Kassa webhook payload');
      return false;
    }

    if (typeof payload.order_id !== 'string' || !payload.order_id.trim()) {
      this.logger.error('Invalid order_id in Kassa webhook payload');
      return false;
    }

    return true;
  }
}
