import { Injectable, BadGatewayException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { createHash } from 'crypto';
import { AppLogger } from '../utils/logger';

export interface KassaPaymentResponse {
  id: string;
  link: string;
}

export interface KassaErrorResponse {
  message: string;
}

export interface KassaCreatePaymentRequest {
  project_id: number;
  order_id: string;
  amount: number;
  currency: 'RUB';
  method: 'sbp';
  success_url?: string;
  failed_url?: string;
  callback_url?: string;
}

@Injectable()
export class KassaService {
  private readonly logger = AppLogger;
  private readonly apiKey: string;
  private readonly projectId: number;
  private readonly baseUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = this.config.getOrThrow<string>('KASSA_API_KEY');
    this.projectId = parseInt(this.config.getOrThrow<string>('KASSA_PROJECT_ID'));
    this.baseUrl = this.config.get<string>('KASSA_API_URL') || 'https://platimaqr.com/api/v1';
    this.logger.log(`Kassa API URL configured: ${this.baseUrl}`);
  }

  /**
   * Создает подпись для авторизации запросов к Kassa API
   * Строка для SHA512: apikey + order_id + project_id + amount + 'RUB'
   */
  private createSignature(orderId: string, amount: number): string {
    const signatureString = this.apiKey + orderId + `${this.projectId}` + `${amount.toFixed(2)}` + 'RUB';
    const hash = createHash('sha512').update(signatureString).digest('hex');
    
    this.logger.debug(`P2PKassa signature generation:`);
    this.logger.debug(`- apikey: ${this.apiKey}`);
    this.logger.debug(`- order_id: ${orderId}`);
    this.logger.debug(`- project_id: ${this.projectId}`);
    this.logger.debug(`- amount: ${amount.toFixed(2)}`);
    this.logger.debug(`- currency: RUB`);
    this.logger.debug(`- signature_string: ${signatureString}`);
    this.logger.debug(`- sha512_hash: ${hash}`);
    
    return hash;
  }

  /**
   * Создает платеж через Kassa API для СБП
   * @param amount Сумма платежа в рублях
   * @param orderId Уникальный номер платежа в системе
   * @param successUrl URL для редиректа при успешной оплате (необязательно)
   * @param failedUrl URL для редиректа при неуспешной оплате (необязательно)
   * @param callbackUrl URL для отправки webhook уведомлений (необязательно)
   */
  async createPayment(
    amount: number,
    orderId: string,
    successUrl?: string,
    failedUrl?: string,
    callbackUrl?: string,
  ): Promise<KassaPaymentResponse> {
    const url = `${this.baseUrl}/acquiring`;
    
    // Если callback URL не передан, используем дефолтный
    const defaultCallbackUrl = callbackUrl || this.config.get<string>('WEBHOOK_BASE_URL');
    const webhookUrl = defaultCallbackUrl ? `${defaultCallbackUrl}/webhooks/kassa` : undefined;
    
    const payload: KassaCreatePaymentRequest = {
      project_id: this.projectId,
      order_id: orderId,
      amount: amount,
      currency: 'RUB',
      method: 'sbp',
    };
    
    // Добавляем дополнительные параметры только если они определены
    if (successUrl) payload.success_url = successUrl;
    if (failedUrl) payload.failed_url = failedUrl;
    if (webhookUrl) payload.callback_url = webhookUrl;

    // Создаем подпись для авторизации
    const signature = this.createSignature(orderId, amount);

    this.logger.log(`Creating Kassa payment: ${orderId}, amount=${amount} RUB`);
    this.logger.debug(`Payload:`, JSON.stringify(payload, null, 2));
    this.logger.debug(`Signature: ${signature}`);
    this.logger.debug(`Project ID: ${this.projectId}`);

    try {
      this.logger.log(`Sending request to Kassa API: ${url}`);
      const response = await firstValueFrom(
        this.http.post<KassaPaymentResponse | KassaErrorResponse>(url, payload, {
          headers: {
            'Authorization': `Bearer ${signature}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      
      this.logger.debug(`P2PKassa API response status: ${response.status}`);
      this.logger.debug(`P2PKassa API response data:`, response.data);

      if ('message' in response.data) {
        throw new BadGatewayException(`P2PKassa API error: ${response.data.message}`);
      }
      
      this.logger.log(`P2PKassa payment created successfully: ${response.data.id}`);
      return response.data;
    } catch (err: any) {
      this.logger.error(`Kassa payment creation failed:`, err.response?.data || err.message);
      
      if (err.response?.status) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 401:
            throw new BadGatewayException('Неверный API-ключ Kassa или неверная подпись');
          case 403:
            throw new BadGatewayException('Нет доступа к Kassa API эндпоинту');
          case 400:
            throw new BadGatewayException(`Некорректный запрос к Kassa API: ${data?.message || 'неизвестная ошибка'},${data}`);
          default:
            throw new BadGatewayException(`Ошибка Kassa API (${status}): ${data?.message || err.message}`);
        }
      }
      
      if (err.code === 'ENOTFOUND') {
        throw new BadGatewayException(`Не удалось подключиться к Kassa API: сервер не найден (${this.baseUrl})`);
      } else if (err.code === 'ECONNREFUSED') {
        throw new BadGatewayException(`Не удалось подключиться к Kassa API: соединение отклонено (${this.baseUrl})`);
      } else if (err.code === 'ETIMEDOUT') {
        throw new BadGatewayException('Превышено время ожидания ответа от Kassa API (1 минута)');
      }
      
      throw new BadGatewayException(`Неизвестная ошибка Kassa API: ${err.message}`);
    }
  }

  // /**
  //  * Проверяет статус платежа по ID
  //  * @param paymentId ID платежа в системе Kassa
  //  */
  // async checkPaymentStatus(paymentId: string): Promise<KassaPaymentResponse> {
  //   const url = `${this.baseUrl}/payment/${paymentId}`;

  //   try {
  //     this.logger.log(`Checking payment status at Kassa API: ${url}`);
  //     const response = await firstValueFrom(
  //       this.http.get<KassaPaymentResponse>(url, {
  //         headers: {
  //           'Authorization': `Bearer ${this.apiKey}`,
  //           'Content-Type': 'application/json',
  //         },
  //         timeout: 60000,
  //       }),
  //     );
      
  //     this.logger.log(`Kassa payment status received for ${paymentId}: ${response.data.status}`);
  //     return response.data;
  //   } catch (err: any) {
  //     this.logger.error(`Kassa payment status check failed:`, err.response?.data || err.message);
      
  //     if (err.response?.status) {
  //       const status = err.response.status;
  //       const data = err.response.data;
        
  //       switch (status) {
  //         case 401:
  //           throw new BadGatewayException('Неверный API-ключ Kassa');
  //         case 403:
  //           throw new BadGatewayException('Нет доступа к Kassa API эндпоинту');
  //         case 404:
  //           throw new BadGatewayException(`Платеж ${paymentId} не найден в Kassa API`);
  //         default:
  //           throw new BadGatewayException(`Ошибка Kassa API (${status}): ${data?.message || err.message}`);
  //       }
  //     }
      
  //     throw new BadGatewayException(`Ошибка проверки статуса платежа: ${err.message}`);
  //   }
  // }

  /**
   * Проверяет доступность Kassa API
   * @returns Объект с информацией о доступности API
   */
  async checkApiAvailability(): Promise<{ available: boolean; message: string }> {
    const url = `${this.baseUrl}/health`;
    this.logger.log(`Checking Kassa API availability: ${url}`);
    
    try {
      await firstValueFrom(
        this.http.get(url, {
          timeout: 5000, // 5 секунд таймаут
        }),
      );
      
      return { available: true, message: 'Kassa API доступен' };
    } catch (err) {
      const error = err as Error;
      let message = `Kassa API недоступен: ${error.message}`;
      
      if (error.message.includes('ENOTFOUND')) {
        message = `Kassa API недоступен: сервер не найден (${this.baseUrl})`;
      } else if (error.message.includes('ECONNREFUSED')) {
        message = `Kassa API недоступен: соединение отклонено (${this.baseUrl})`;
      } else if (error.message.includes('timeout')) {
        message = `Kassa API недоступен: превышено время ожидания (${this.baseUrl})`;
      }
      
      this.logger.error(message, error);
      return { available: false, message };
    }
  }

  /**
   * Создает подпись для проверки webhook уведомлений
   * (Может понадобиться для верификации входящих webhook'ов)
   */
  createWebhookSignature(orderId: string, amount: number): string {
    return this.createSignature(orderId, amount);
  }
}
