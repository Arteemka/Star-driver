import { Injectable, BadGatewayException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AppLogger } from '../utils/logger';

export interface WataPaymentResponse {
  id: string;
  terminalName: string;
  terminalPublicId: string;
  type: string; // CardCrypto или SBP
  amount: number;
  currency: string;
  status: string; // Pending, Paid, Declined
  errorCode?: string;
  errorDescription?: string;
  orderId: string;
  orderDescription: string;
  creationTime: string;
  paymentTime?: string;
  totalCommission?: number;
  sbpLink?: string;
  paymentLinkId?: string;
}

// Интерфейс для создания платежной ссылки
export interface WataCreatePaymentLinkRequest {
  amount: number;
  currency: string;
  description?: string;
  orderId?: string;
  successRedirectUrl?: string;
  failRedirectUrl?: string;
  expirationDateTime?: string;
  webhookUrl?: string;
}

// Ответ при создании платежной ссылки
export interface WataCreatePaymentLinkResponse {
  id: string;
  amount: number;
  currency: string;
  status: string; // Opened, Closed
  url: string;
  terminalName: string;
  terminalPublicId: string;
  creationTime: string;
  orderId?: string;
  description?: string;
  successRedirectUrl?: string;
  failRedirectUrl?: string;
  expirationDateTime?: string;
}

@Injectable()
export class WataService {
  private readonly logger = AppLogger;
  private readonly accessToken: string;
  private readonly baseUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.accessToken = this.config.getOrThrow<string>('WATA_ACCESS_TOKEN');
    // Используем URL из конфигурации или значение по умолчанию
    this.baseUrl = this.config.get<string>('WATA_API_URL') || 'https://api-sandbox.wata.pro/api/h2h';
    this.logger.log(`WATA API URL configured: ${this.baseUrl}`);
  }

  /**
   * Создает платежную ссылку через WATA API
   * @param amount Сумма платежа
   * @param currency Валюта платежа (RUB, EUR, USD)
   * @param description Описание заказа
   * @param orderId Идентификатор заказа в системе мерчанта
   * @param successRedirectUrl URL для перенаправления при успешной оплате
   * @param failRedirectUrl URL для перенаправления при неуспешной оплате
   */
  async createPaymentLink(
    amount: number,
    currency: string,
    description?: string,
    orderId?: string,
    successRedirectUrl?: string,
    failRedirectUrl?: string,
    callbackUrl?: string,
  ): Promise<WataCreatePaymentLinkResponse> {
    const url = `${this.baseUrl}links`;
    
    // Если callback URL не передан, используем дефолтный
    const defaultCallbackUrl = callbackUrl || this.config.get<string>('WEBHOOK_BASE_URL');
    const webhookUrl = defaultCallbackUrl ? `${defaultCallbackUrl}/webhooks/wata` : undefined;
    
    const payload: WataCreatePaymentLinkRequest = {
      amount: Number(amount.toFixed(2)),
      currency,
      description,
      orderId,
      successRedirectUrl,
      failRedirectUrl,
      webhookUrl, // Добавляем webhook URL
    };

    this.logger.log(`Creating WATA payment link: ${orderId}, amount=${amount} ${currency}`);

    try {
      this.logger.log(`Sending request to WATA API: ${url}`);
      const response = await firstValueFrom(
        this.http.post<WataCreatePaymentLinkResponse>(url, payload, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      
      this.logger.log(`WATA payment link created: ${response.data.url}`);
      return response.data;
    } catch (err: any) {
      this.logger.error(`WATA payment link creation failed:`, err.response?.data || err.message);
      
      if (err.response?.status) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 401:
            throw new BadGatewayException('Неверный access-token WATA API или токен истек');
          case 403:
            throw new BadGatewayException('Нет доступа к WATA API эндпоинту');
          case 400:
            throw new BadGatewayException(`Некорректный запрос к WATA API: ${data?.message || 'неизвестная ошибка'}`);
          default:
            throw new BadGatewayException(`Ошибка WATA API (${status}): ${data?.message || err.message}`);
        }
      }
      
      if (err.code === 'ENOTFOUND') {
        throw new BadGatewayException(`Не удалось подключиться к WATA API: сервер не найден (${this.baseUrl})`);
      } else if (err.code === 'ECONNREFUSED') {
        throw new BadGatewayException(`Не удалось подключиться к WATA API: соединение отклонено (${this.baseUrl})`);
      } else if (err.code === 'ETIMEDOUT') {
        throw new BadGatewayException('Превышено время ожидания ответа от WATA API (1 минута)');
      }
      
      throw new BadGatewayException(`Неизвестная ошибка WATA API: ${err.message}`);
    }
  }

  /**
   * Получает платежную ссылку по ID
   * @param linkId Идентификатор платежной ссылки
   */
  async getPaymentLink(linkId: string): Promise<WataCreatePaymentLinkResponse> {
    const url = `${this.baseUrl}links/${linkId}`;

    try {
      this.logger.log(`Getting payment link from WATA API: ${url}`);
      const response = await firstValueFrom(
        this.http.get<WataCreatePaymentLinkResponse>(url, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      
      this.logger.log(`WATA payment link retrieved: ${response.data.id}`);
      return response.data;
    } catch (err: any) {
      this.logger.error(`WATA payment link retrieval failed:`, err.response?.data || err.message);
      
      if (err.response?.status) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 401:
            throw new BadGatewayException('Неверный access-token WATA API или токен истек');
          case 403:
            throw new BadGatewayException('Нет доступа к WATA API эндпоинту');
          case 404:
            throw new BadGatewayException(`Платежная ссылка ${linkId} не найдена`);
          default:
            throw new BadGatewayException(`Ошибка WATA API (${status}): ${data?.message || err.message}`);
        }
      }
      
      throw new BadGatewayException(`Ошибка получения платежной ссылки: ${err.message}`);
    }
  }

  /**
   * Проверяет статус платежа по ID транзакции
   * @param transactionId ID транзакции в системе WATA
   */
  async checkPaymentStatus(transactionId: string): Promise<WataPaymentResponse> {
    const url = `${this.baseUrl}transactions/${transactionId}`;

    try {
      this.logger.log(`Checking payment status at WATA API: ${url}`);
      const response = await firstValueFrom(
        this.http.get<WataPaymentResponse>(url, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      
      this.logger.log(`WATA payment status received for ${transactionId}: ${response.data.status}`);
      return response.data;
    } catch (err: any) {
      this.logger.error(`WATA payment status check failed:`, err.response?.data || err.message);
      
      if (err.response?.status) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 401:
            throw new BadGatewayException('Неверный access-token WATA API или токен истек');
          case 403:
            throw new BadGatewayException('Нет доступа к WATA API эндпоинту');
          case 404:
            throw new BadGatewayException(`Транзакция ${transactionId} не найдена в WATA API`);
          default:
            throw new BadGatewayException(`Ошибка WATA API (${status}): ${data?.message || err.message}`);
        }
      }
      
      throw new BadGatewayException(`Ошибка проверки статуса платежа: ${err.message}`);
    }
  }

  /**
   * Поиск транзакций по параметрам
   * @param params Параметры поиска
   */
  async searchTransactions(params: {
    amountFrom?: number;
    amountTo?: number;
    currencies?: string[];
    statuses?: string[];
    orderId?: string;
    skipCount?: number;
    maxResultCount?: number;
    sorting?: string;
  }): Promise<{ totalCount: number; items: WataPaymentResponse[] }> {
    const url = `${this.baseUrl}transactions/`;
    const queryParams = new URLSearchParams();

    if (params.amountFrom) queryParams.append('amountFrom', params.amountFrom.toString());
    if (params.amountTo) queryParams.append('amountTo', params.amountTo.toString());
    if (params.currencies?.length) queryParams.append('currencies', params.currencies.join(','));
    if (params.statuses?.length) queryParams.append('statuses', params.statuses.join(','));
    if (params.orderId) queryParams.append('orderId', params.orderId);
    if (params.skipCount) queryParams.append('skipCount', params.skipCount.toString());
    if (params.maxResultCount) queryParams.append('maxResultCount', params.maxResultCount.toString());
    if (params.sorting) queryParams.append('sorting', params.sorting);

    const fullUrl = `${url}?${queryParams.toString()}`;

    try {
      this.logger.log(`Searching transactions at WATA API: ${fullUrl}`);
      const response = await firstValueFrom(
        this.http.get<{ totalCount: number; items: WataPaymentResponse[] }>(fullUrl, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      
      this.logger.log(`Found ${response.data.totalCount} transactions`);
      return response.data;
    } catch (err: any) {
      this.logger.error(`WATA transactions search failed:`, err.response?.data || err.message);
      
      if (err.response?.status) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 401:
            throw new BadGatewayException('Неверный access-token WATA API или токен истек');
          case 403:
            throw new BadGatewayException('Нет доступа к WATA API эндпоинту');
          case 400:
            throw new BadGatewayException(`Некорректные параметры поиска: ${data?.message || 'неизвестная ошибка'}`);
          default:
            throw new BadGatewayException(`Ошибка WATA API (${status}): ${data?.message || err.message}`);
        }
      }
      
      throw new BadGatewayException(`Ошибка поиска транзакций: ${err.message}`);
    }
  }

  /**
   * Проверяет доступность WATA API
   * @returns Объект с информацией о доступности API
   */
  async checkApiAvailability(): Promise<{ available: boolean; message: string }> {
    const url = `${this.baseUrl}/health`;
    this.logger.log(`Checking WATA API availability: ${url}`);
    
    try {
      await firstValueFrom(
        this.http.get(url, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000, // 5 секунд таймаут
        }),
      );
      
      return { available: true, message: 'WATA API доступен' };
    } catch (err) {
      const error = err as Error;
      let message = `WATA API недоступен: ${error.message}`;
      
      if (error.message.includes('ENOTFOUND')) {
        message = `WATA API недоступен: сервер не найден (${this.baseUrl})`;
      } else if (error.message.includes('ECONNREFUSED')) {
        message = `WATA API недоступен: соединение отклонено (${this.baseUrl})`;
      } else if (error.message.includes('timeout')) {
        message = `WATA API недоступен: превышено время ожидания (${this.baseUrl})`;
      }
      
      this.logger.error(message, error);
      return { available: false, message };
    }
  }
}