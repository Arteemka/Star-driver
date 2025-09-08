import { 
  Controller, 
  Post, 
  Body, 
  Headers, 
  Logger, 
  HttpCode, 
  HttpStatus,
  BadRequestException,
  Req
} from '@nestjs/common';
import { Request } from 'express';
import { WataWebhookService } from './wata-webhook.service';
import { WataSignatureService } from './wata-signature.service';

// Интерфейс для webhook уведомления от WATA
export interface WataWebhookPayload {
  transactionType: string; // CardCrypto, SBP, T-Pay
  transactionId: string;
  terminalPublicId: string;
  transactionStatus: string; // Paid, Declined
  errorCode?: string;
  errorDescription?: string;
  terminalName: string;
  amount: number;
  currency: string;
  orderId: string;
  orderDescription: string;
  commission: number;
  paymentTime: string;
  email?: string;
}

@Controller('webhooks/wata')
export class WataWebhookController {
  private readonly logger = new Logger(WataWebhookController.name);

  constructor(
    private readonly wataWebhookService: WataWebhookService,
    private readonly wataSignatureService: WataSignatureService,
  ) {}

  /**
   * Обработчик webhook уведомлений от WATA с правильной проверкой подписи
   * Использует raw body для корректной проверки RSA подписи
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: Request,
    @Headers('x-signature') signature: string,
    @Headers() headers: any,
  ): Promise<{ success: boolean }> {
    // Получаем raw body из middleware (или fallback)
    const rawBody = (req as any).rawBody || (req.body ? JSON.stringify(req.body) : '');
    
    let payload: WataWebhookPayload;
    try {
      payload = req.body;
      if (typeof req.body === 'string') {
        payload = JSON.parse(req.body);
      }
    } catch (error) {
      this.logger.error('Failed to parse webhook payload:', error);
      throw new BadRequestException('Invalid JSON payload');
    }

    this.logger.log(`Received WATA webhook for transaction: ${payload.transactionId}`);
    
    // Логируем полученные данные
    console.log('=== WATA WEBHOOK RECEIVED ===');
    console.log('Headers:', headers);
    console.log('Signature:', signature);
    console.log('Raw Body Length:', rawBody.length);
    console.log('Raw Body Preview:', rawBody.substring(0, 200));
    console.log('Parsed Payload:', JSON.stringify(payload, null, 2));
    console.log('===========================');

    try {
      // Проверяем подпись webhook'а для безопасности используя новый сервис
      const isValidSignature = await this.wataSignatureService.verifySignature(
        rawBody,
        signature
      );

      if (!isValidSignature) {
        this.logger.warn(`Invalid signature for transaction: ${payload.transactionId}`);
        
        // Дополнительная проверка для отладки
        const debugResult = await this.wataSignatureService.verifySignatureDebug(rawBody, signature);
        console.log('🔍 Signature verification debug:', debugResult);
        
        throw new BadRequestException('Invalid signature');
      }

      console.log('✅ Signature verification successful!');
      
      // Обрабатываем webhook
      await this.wataWebhookService.processWebhook(payload);

      this.logger.log(`Successfully processed WATA webhook for transaction: ${payload.transactionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to process WATA webhook:`, error);
      throw error;
    }
  }

  /**
   * Старый обработчик webhook (оставлен для совместимости)
   * @deprecated Используйте основной POST endpoint
   */
  @Post('legacy')
  @HttpCode(HttpStatus.OK)
  async handleWebhookLegacy(
    @Body() payload: WataWebhookPayload,
    @Headers('x-signature') signature: string,
    @Headers() headers: any,
  ): Promise<{ success: boolean }> {
    this.logger.log(`Received WATA webhook (legacy) for transaction: ${payload.transactionId}`);
    
    console.log('=== WATA WEBHOOK LEGACY ===');
    console.log('Headers:', headers);
    console.log('Signature:', signature);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('============================');

    try {
      // Используем старый метод проверки подписи
      const rawBody = JSON.stringify(payload);
      const isValidSignature = await this.wataWebhookService.verifySignature(
        rawBody,
        signature
      );

      if (!isValidSignature) {
        this.logger.warn(`Invalid signature for transaction: ${payload.transactionId}`);
        throw new BadRequestException('Invalid signature');
      }

      // Обрабатываем webhook
      await this.wataWebhookService.processWebhook(payload);

      this.logger.log(`Successfully processed WATA webhook for transaction: ${payload.transactionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to process WATA webhook:`, error);
      throw error;
    }
  }

  /**
   * Тестовый endpoint для проверки webhook'ов (можно удалить в продакшене)
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testWebhook(@Body() payload: any): Promise<{ success: boolean }> {
    console.log('=== TEST WATA WEBHOOK ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('========================');
    
    return { success: true };
  }
}
