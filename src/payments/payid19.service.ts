import { Injectable, BadGatewayException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AppLogger } from '../utils/logger';

// Интерфейс для запроса создания инвойса PayID19
export interface PayID19CreateInvoiceRequest {
  public_key: string;
  private_key: string;
  test?: number; // 1 для тестового инвойса, null для реального
  email?: string;
  merchant_id?: string;
  order_id?: string;
  customer_id?: number;
  price_amount: number;
  price_currency?: string; // По умолчанию USD
  add_fee_to_price?: number; // 1 для добавления комиссии к цене
  title?: string;
  description?: string;
  banned_coins?: string[]; // JSON массив запрещенных монет
  callback_url?: string;
  cancel_url?: string;
  success_url?: string;
  expiration_date?: number; // Срок истечения в часах (по умолчанию 6, максимум 6)
  margin_ratio?: number; // Допустимая погрешность платежа
  white_label?: number; // 1 для white-label интерфейса
}

// Ответ от PayID19 API при создании инвойса
export interface PayID19CreateInvoiceResponse {
  status: 'success' | 'error';
  message: string | string[]; // URL инвойса при успехе или массив ошибок
}

// Данные webhook'а от PayID19
export interface PayID19WebhookData {
  private_key: string; // Для сверки с вашим приватным ключом
  id: string;
  email?: string;
  merchant_id?: string;
  order_id?: string;
  customer_id?: number;
  price_amount: number;
  price_currency: string;
  amount: number; // Фактически полученная сумма
  amount_currency: string; // Валюта фактического платежа
  add_fee_to_price?: number;
  title?: string;
  description?: string;
  ref_url?: string;
  cancel_url?: string;
  success_url?: string;
  callback_url?: string;
  ip: string;
  test: number; // 0 или 1
  created_at: string;
  expiration_date: string;
}

@Injectable()
export class PayID19Service {
  private readonly logger = AppLogger;
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
 

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.publicKey = this.config.getOrThrow<string>('PAYID19_PUBLIC_KEY');
    this.privateKey = this.config.getOrThrow<string>('PAYID19_PRIVATE_KEY');
    this.baseUrl = 'https://payid19.com/api/v1';

    this.logger.log(`PayID19 API configured`);
    this.logger.log(`Public Key: ${this.publicKey.substring(0, 8)}...`);
   
  }

  /**
   * Создает инвойс для криптоплатежа через PayID19
   * @param amount Сумма платежа
   * @param currency Валюта платежа (по умолчанию USD)
   * @param description Описание заказа
   * @param orderId Идентификатор заказа в системе мерчанта
   * @param email Email покупателя (опционально)
   */
  async createInvoice(
    amount: number,
    currency: string = 'USD',
    description?: string,
    orderId?: string,
    email?: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/create_invoice`;
    
    // Получаем base URL для callback'а
    const callbackBaseUrl = this.config.get<string>('WEBHOOK_BASE_URL');
    const callbackUrl = callbackBaseUrl ? `${callbackBaseUrl}/webhooks/payid19` : undefined;
    
    const payload: PayID19CreateInvoiceRequest = {
      public_key: this.publicKey,
      private_key: this.privateKey,
      test: 0,
      price_amount: Number(amount.toFixed(2)),
      price_currency: currency,
      order_id: orderId,
      email,
      title: 'Покупка звёзд Telegram',
      description: description || 'Покупка звёзд через криптовалюту',
      callback_url: callbackUrl,
      expiration_date: 1, //1 час
      margin_ratio: 0.1, 
    };

    this.logger.log(`Creating PayID19 invoice: ${orderId}, amount=${amount} ${currency}`);
    this.logger.log(`PayID19 request payload:`, JSON.stringify({
      ...payload,
      private_key: '[HIDDEN FOR SECURITY]'
    }, null, 2));

    try {
      this.logger.log(`Sending request to PayID19 API: ${url}`);
      this.logger.log(`Request headers: Content-Type: application/json`);

      
      const response = await firstValueFrom(
        this.http.post<PayID19CreateInvoiceResponse>(url, payload, {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 300000, 
        }),
      );
      
      this.logger.log(`PayID19 API response status: ${response.status}`);
      this.logger.log(`PayID19 API response data:`, JSON.stringify(response.data, null, 2));
      
      if (response.data.status === 'error') {
        const errorMessage = Array.isArray(response.data.message) 
          ? response.data.message.join(', ') 
          : response.data.message;
        
        this.logger.error(`PayID19 API returned error: ${errorMessage}`);
        throw new BadGatewayException(`Ошибка PayID19: ${errorMessage}`);
      }
      
      const invoiceUrl = response.data.message as string;
      this.logger.log(`PayID19 invoice created successfully: ${invoiceUrl}`);
      
      return invoiceUrl;
    } catch (err: any) {
      this.logger.error(`PayID19 invoice creation failed:`, {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      });
      
      if (err.response) {
        const status = err.response.status;
        const data = err.response.data;
        
        switch (status) {
          case 400:
            throw new BadGatewayException(`Некорректный запрос к PayID19: ${JSON.stringify(data)}`);
          case 401:
            throw new BadGatewayException('Неверные ключи доступа к PayID19 API');
          case 403:
            throw new BadGatewayException('Нет доступа к PayID19 API');
          case 429:
            throw new BadGatewayException('Превышен лимит запросов к PayID19 API');
          default:
            throw new BadGatewayException(
              `Ошибка PayID19 API (${status}): ${JSON.stringify(data)}`
            );
        }
      } else if (err.code === 'ENOTFOUND') {
        throw new BadGatewayException(`Не удалось подключиться к PayID19 API: сервер не найден`);
      } else if (err.code === 'ECONNREFUSED') {
        throw new BadGatewayException(`Не удалось подключиться к PayID19 API: соединение отклонено`);
      } else if (err.code === 'ETIMEDOUT') {
        throw new BadGatewayException('Превышено время ожидания ответа от PayID19 API (30 секунд)');
      }
      
      throw new BadGatewayException(`Неизвестная ошибка PayID19 API: ${err.message}`);
    }
  }

  /**
   * Проверяет валидность webhook'а от PayID19
   * @param webhookData Данные из webhook'а
   */
  validateWebhook(webhookData: PayID19WebhookData): boolean {
    return webhookData.private_key === this.privateKey;
  }

  /**
   * Возвращает список поддерживаемых криптовалют (для информации)
   */
  getSupportedCryptocurrencies(): string[] {
    return [
      'USDT (TRC20, ERC20, BEP20)',
      'Bitcoin (BTC)',
      'Ethereum (ETH)',
      'Binance Coin (BNB)',
      'Tron (TRX)',
      'Litecoin (LTC)',
      'USDC (ERC20, BEP20)',
      'Dogecoin (DOGE)',
      'Bitcoin Cash (BCH)',
      'Polygon (MATIC)',
    ];
  }

  /**
   * Форматирует список поддерживаемых валют для отображения пользователю
   */
  getFormattedCryptocurrencies(): string {
    return this.getSupportedCryptocurrencies()
      .map(currency => `• ${currency}`)
      .join('\n');
  }
}
