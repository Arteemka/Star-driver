import { Injectable, BadGatewayException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AppLogger } from '../utils/logger';

// Ответ аутентификации Fragment API
export interface FragmentAuthResponse {
  token: string;
}

// Ответ заказа звёзд Fragment API
export interface StarsOrderResponse {
  success: boolean;
  id: string;
  receiver: string;
  goods_quantity: number;
  username: string;
  sender: {
    phone_number: string;
    name: string;
  };
  ton_price: string;
  ref_id: string;
}

// Ответ баланса кошелька Fragment API
export interface WalletBalanceResponse {
  balance: string; // баланс в TON
  address: string;
}

@Injectable()
export class FragmentService {
  private readonly logger = AppLogger;
  private jwtToken: string | null = null;
  private readonly apiKey: string;
  private readonly phoneNumber: string;
  private readonly mnemonics: string[];
  private readonly baseUrl: string;
  private readonly presetJwtToken?: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = this.config.getOrThrow<string>('FRAGMENT_API_KEY');
    this.phoneNumber = this.config.getOrThrow<string>('FRAGMENT_PHONE_NUMBER');
    // MNEMONICS: массив из 24 слов
    const raw = this.config.getOrThrow<string>('FRAGMENT_MNEMONICS').trim();
    this.mnemonics = raw.split(/\s+/).filter((w) => w.length);
    // Новый URL Fragment API
    this.baseUrl = 'https://api.fragment-api.com/v1';
    
    // Проверяем, есть ли готовый JWT токен
    this.presetJwtToken = this.config.get<string>('FRAGMENT_JWT_TOKEN');
    if (this.presetJwtToken) {
      this.jwtToken = this.presetJwtToken;
      this.logger.log('Using preset JWT token from environment');
    }
    
    this.logger.log(`Fragment API configured: ${this.baseUrl}`);
    this.logger.log(`API Key: ${this.apiKey.substring(0, 8)}...`);
    this.logger.log(`Phone: ${this.phoneNumber}`);
    this.logger.log(`Mnemonics count: ${this.mnemonics.length}`);
    this.logger.log(`JWT Token available: ${this.jwtToken ? 'YES' : 'NO'}`);
  }

  /**
   * Аутентификация в Fragment API, получение JWT-токена
   */
  private async authenticate(): Promise<void> {
    this.logger.log('Authenticating with Fragment API');
    const url = `${this.baseUrl}/auth/authenticate/`;

    const payload = {
      api_key: this.apiKey,
      phone_number: this.phoneNumber,
      mnemonics: this.mnemonics,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<{ token: string }>(url, payload, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      this.jwtToken = response.data.token;
      this.logger.log('Fragment JWT token acquired');
    } catch (err) {
      this.logger.error('Fragment authentication failed', err as Error);
      throw new BadGatewayException(
        'Не удалось аутентифицироваться в Fragment API',
      );
    }
  }

  /**
   * Создаёт заказ звёзд через Fragment API
   * @param receiver Telegram username без '@'
   * @param quantity количество звёзд (минимум 50)
   * @param showSender показывать отправителя в заказе
   */
  async buyStars(
    username: string,
    quantity: number,
    showSender = false,
  ): Promise<StarsOrderResponse> {
    if (!this.jwtToken) {
      await this.authenticate();
    }

    const url = `${this.baseUrl}/order/stars/`;
    const body = { username, quantity, show_sender: showSender };
    this.logger.log(`Creating stars order for @${username}, qty=${quantity}`);

    try {
      this.logger.log(`Making request to Fragment API: ${url}`);
      this.logger.log(`Request body: ${JSON.stringify(body)}`);
      this.logger.log(`JWT token length: ${this.jwtToken?.length || 'null'}`);
      
      const response = await firstValueFrom(
        this.http.post<StarsOrderResponse>(url, body, {
          headers: {
            Authorization: `JWT ${this.jwtToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 300000, // 5 минуты
        }),
      );
      
      this.logger.log(`Order created successfully: ${response.data.id}`);
      return response.data;
    } catch (err: any) {
      this.logger.error('Fragment create order failed:', {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        config: {
          url: err.config?.url,
          method: err.config?.method,
          // НЕ логируем headers из-за JWT токена
        }
      });
      
      // Более детальная обработка ошибок
      if (err.response) {
        const status = err.response.status;
        const data = err.response.data;
        
        if (status === 401) {
          throw new BadGatewayException('JWT токен недействителен или истек');
        } else if (status === 400) {
          throw new BadGatewayException(`Некорректные параметры запроса: ${JSON.stringify(data)}`);
        } else if (status === 429) {
          throw new BadGatewayException('Превышен лимит запросов к Fragment API');
        } else {
          throw new BadGatewayException(
            `Fragment API вернул ошибку ${status}: ${JSON.stringify(data)}`
          );
        }
      } else if (err.code === 'ECONNABORTED') {
        throw new BadGatewayException('Таймаут при обращении к Fragment API');
      } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new BadGatewayException('Не удается подключиться к Fragment API');
      } else {
        throw new BadGatewayException(
          `Неизвестная ошибка Fragment API: ${err.message}`
        );
      }
    }
  }

  /**
   * Получает баланс кошелька Fragment
   * @returns Баланс кошелька в TON
   */
  async getWalletBalance(): Promise<WalletBalanceResponse> {
    if (!this.jwtToken) {
      await this.authenticate();
    }

    const url = `${this.baseUrl}/misc/wallet/`;
    this.logger.log('Getting wallet balance from Fragment API');

    try {
      this.logger.log(`Making request to Fragment API: ${url}`);
      this.logger.log(`JWT token length: ${this.jwtToken?.length || 'null'}`);
      
      const response = await firstValueFrom(
        this.http.get<WalletBalanceResponse>(url, {
          headers: {
            Authorization: `JWT ${this.jwtToken}`,
            Accept: 'application/json',
          },
          timeout: 300000, // 5 мин
        }),
      );
      
      this.logger.log(`Wallet balance retrieved: ${response.data.balance} TON`);
     
      return response.data;
    } catch (err: any) {
      this.logger.error('Fragment wallet balance request failed:', {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        config: {
          url: err.config?.url,
          method: err.config?.method,
          // НЕ логируем headers из-за JWT токена
        }
      });
      
      // Обработка ошибок
      if (err.response) {
        const status = err.response.status;
        const data = err.response.data;
        
        if (status === 401) {
          throw new BadGatewayException('API ключ недействителен');
        } else if (status === 429) {
          throw new BadGatewayException('Превышен лимит запросов к Fragment API');
        } else {
          throw new BadGatewayException(
            `Fragment API вернул ошибку ${status}: ${JSON.stringify(data)}`
          );
        }
      } else if (err.code === 'ECONNABORTED') {
        throw new BadGatewayException('Таймаут при обращении к Fragment API');
      } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new BadGatewayException('Не удается подключиться к Fragment API');
      } else {
        throw new BadGatewayException(
          `Неизвестная ошибка Fragment API: ${err.message}`
        );
      }
    }
  }

  /**
   * Рассчитывает стоимость звёзд в TON
   * @param starsCount Количество звёзд
   * @returns Стоимость в TON (приблизительная)
   */
  calculateStarsCostInTon(starsCount: number): number {
    // Примерный курс: 1 звезда ≈ 0.0001 TON (может варьироваться)
    // Это приблизительное значение, точная стоимость зависит от Fragment
    const tonPerStar = 0.0001;
    return starsCount * tonPerStar;
  }
}
