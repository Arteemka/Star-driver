import { 
  Controller, 
  Post, 
  Body, 
  Headers, 
  Logger, 
  HttpCode, 
  HttpStatus,
  BadRequestException
} from '@nestjs/common';
import { KassaWebhookService } from './kassa-webhook.service';
import { KassaSignatureService } from './kassa-signature.service';

// Интерфейс для webhook уведомления от P2PKassa
export interface KassaWebhookPayload {
  id: string; // Уникальный ID платежа в системе P2PKassa (UUID)
  createDateTime: string; // Дата создания платежа в формате YYYY-MM-DD HH:MM:SS
  order_id: string; // Номер платежа в вашей системе
  project_id: number; // ID вашего проекта
  amount: number; // Исходная сумма платежа (в рублях)
  currency: string; // Исходная валюта платежа (RUB)
  amount_pay: number; // Сумма, которую фактически оплатил пользователь
  currency_pay: string; // Валюта, в которой пользователь фактически произвёл оплату
  sign: string; // Подпись уведомления (SHA256)
}

@Controller('webhooks/kassa')
export class KassaWebhookController {
  private readonly logger = new Logger(KassaWebhookController.name);

  constructor(
    private readonly kassaWebhookService: KassaWebhookService,
    private readonly kassaSignatureService: KassaSignatureService,
  ) {}

  /**
   * Обработчик webhook уведомлений от Kassa
   * Использует проверку подписи SHA256 для безопасности
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() payload: KassaWebhookPayload,
    @Headers() headers: any,
  ): Promise<{ status: string }> {
    this.logger.log(`Received Kassa webhook for order: ${payload.order_id}`);
    
    // Логируем полученные данные
    console.log('=== KASSA WEBHOOK RECEIVED ===');
    console.log('Headers:', headers);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('===============================');

    try {
      // Валидируем структуру payload
      const isValidPayload = this.kassaSignatureService.validateWebhookPayload(payload);
      if (!isValidPayload) {
        this.logger.error('Invalid webhook payload structure');
        throw new BadRequestException('Invalid payload structure');
      }

      // Проверяем подпись webhook'а для безопасности
      const isValidSignature = await this.kassaSignatureService.verifyWebhookSignature(payload);

      if (!isValidSignature) {
        this.logger.warn(`Invalid signature for Kassa webhook: order ${payload.order_id}`);
        throw new BadRequestException('Invalid signature');
      }

      console.log('✅ Kassa webhook signature verification successful!');
      
      // Обрабатываем webhook
      await this.kassaWebhookService.processWebhook(payload);

      this.logger.log(`Successfully processed Kassa webhook for order: ${payload.order_id}`);
      
      // Возвращаем статус OK как требует Kassa
      return { status: 'ok' };
    } catch (error) {
      this.logger.error(`Failed to process Kassa webhook:`, error);
      
      // Если это проблема с подписью или валидацией, возвращаем error статус
      if (error instanceof BadRequestException) {
        return { status: 'error' };
      }
      
      // Для других ошибок также возвращаем error
      return { status: 'error' };
    }
  }

  
}
