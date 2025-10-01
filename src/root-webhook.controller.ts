import { 
  Controller, 
  Post, 
  Headers, 
  Logger, 
  HttpCode, 
  HttpStatus,
  BadRequestException,
  Req
} from '@nestjs/common';
import { Request } from 'express';
//import { WataWebhookService } from './payments/wata-webhook.service';
//import { WataSignatureService } from './payments/wata-signature.service';
//import { WataWebhookPayload } from './payments/wata-webhook.controller';
import { PayID19WebhookService } from './payments/payid19-webhook.service';
import { PayID19WebhookData } from './payments/payid19.service';
import { KassaWebhookService } from './payments/kassa-webhook.service';
import { KassaSignatureService } from './payments/kassa-signature.service';



/**
 * Контроллер для обработки различных webhook'ов на корневом пути "/"
 * Поддерживает WATA, PayID19 и P2PKassa webhook'ы
 */
@Controller('')
export class RootWebhookController {
  private readonly logger = new Logger(RootWebhookController.name);

  constructor(
   // private readonly wataWebhookService: WataWebhookService,
   // private readonly wataSignatureService: WataSignatureService,
    private readonly payid19WebhookService: PayID19WebhookService,
    private readonly kassaWebhookService: KassaWebhookService,
    private readonly kassaSignatureService: KassaSignatureService,
  ) {}

  /**
   * Обработчик различных webhook'ов на корневом пути "/"
   * Определяет тип webhook'а и перенаправляет в соответствующий сервис
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleRootWebhook(
    @Req() req: Request,
    @Headers('x-signature') signature: string,
    @Headers() headers: any,
  ): Promise<{ success: boolean }> {
    // Получаем raw body из middleware (или fallback)
    const rawBody = (req as any).rawBody || (req.body ? JSON.stringify(req.body) : '');
    
    let payload: any;
    try {
      payload = req.body;
      if (typeof req.body === 'string') {
        payload = JSON.parse(req.body);
      }
    } catch (error) {
      this.logger.error('Failed to parse root webhook payload:', error);
      throw new BadRequestException('Invalid JSON payload');
    }

    // Определяем тип webhook'а по наличию специфичных полей
    const isWataWebhook = payload.transactionType && payload.transactionId && payload.transactionStatus;
    const isPayID19Webhook = payload.id && payload.order_id && payload.price_amount && payload.private_key;
    const isP2PKassaWebhook = payload.id && payload.order_id && payload.project_id && payload.amount && payload.sign && !payload.price_amount;
   
   // if (isWataWebhook) {
    //  return this.handleWataWebhook(payload as WataWebhookPayload, rawBody, signature, headers);
    
   // } else
    if (isPayID19Webhook) {
      return this.handlePayID19Webhook(payload as PayID19WebhookData, headers);
      
    } else if (isP2PKassaWebhook) {
      return this.handleP2PKassaWebhook(payload, headers);
      
    } else {
      this.logger.warn('Received unknown webhook type on root path:', { 
        hasTransactionType: !!payload.transactionType,
        hasTransactionId: !!payload.transactionId,
        hasId: !!payload.id,
        hasOrderId: !!payload.order_id,
        hasPriceAmount: !!payload.price_amount,
        hasPrivateKey: !!payload.private_key,
        hasProjectId: !!payload.project_id,
        hasAmount: !!payload.amount,
        hasSign: !!payload.sign,
        hasCreateDateTime: !!payload.createDateTime
      });
      return { success: false };
    }

  }

  /**
   * Обрабатывает WATA webhook
   */
  // private async handleWataWebhook(
  //   payload: WataWebhookPayload,
  //   rawBody: string,
  //   signature: string,
  //   headers: any
  // ): Promise<{ success: boolean }> {
  //   this.logger.log(`🎯 Received WATA webhook on root path for transaction: ${payload.transactionId}`);
    
  //   // Логируем полученные данные
  //   console.log('=== WATA WEBHOOK ON ROOT PATH ===');
  //   console.log('Headers:', headers);
  //   console.log('Signature:', signature);
  //   console.log('Raw Body Length:', rawBody.length);
  //   console.log('Raw Body Preview:', rawBody.substring(0, 200));
  //   console.log('Parsed Payload:', JSON.stringify(payload, null, 2));
  //   console.log('================================');

  //   try {
  //     // ВРЕМЕННО: Отключаем проверку подписи для тестирования
  //     // TODO: Исправить проверку подписи после тестирования
  //     console.log('⚠️ ВНИМАНИЕ: Проверка подписи временно отключена!');
      
  //     let isValidSignature = false;
      
  //     try {
  //       // Пытаемся проверить подпись для отладки
  //       isValidSignature = await this.wataSignatureService.verifySignature(
  //         rawBody,
  //         signature
  //       );
        
  //       if (isValidSignature) {
  //         console.log('✅ Подпись корректна!');
  //       } else {
  //         console.log('⚠️ Подпись некорректна, но продолжаем обработку для тестирования');
  //       }
  //     } catch (signError) {
  //       console.log('⚠️ Ошибка проверки подписи:', signError instanceof Error ? signError.message : 'Unknown error');
  //     }
      
  //     // Обрабатываем webhook через основной сервис (БЕЗ проверки подписи)
  //     await this.wataWebhookService.processWebhook(payload);

  //     this.logger.log(`✅ Successfully processed root WATA webhook for transaction: ${payload.transactionId}`);
  //     return { success: true };
  //   } catch (error) {
  //     this.logger.error(`❌ Failed to process root WATA webhook:`, error);
  //     throw error;
  //   }
  // }

  /**
   * Обрабатывает PayID19 webhook
   */
  private async handlePayID19Webhook(
    payload: PayID19WebhookData,
    headers: any
  ): Promise<{ success: boolean }> {
    this.logger.log(`🪙 Received PayID19 webhook on root path for order: ${payload.order_id}`);
    
    // Логируем полученные данные
    console.log('=== PAYID19 WEBHOOK ON ROOT PATH ===');
    console.log('Headers:', headers);
    console.log('Parsed Payload:', JSON.stringify(payload, null, 2));
    console.log('=====================================');

    try {
      // Проверяем валидность webhook'а (сверяем private_key)
      const isValid = await this.payid19WebhookService.validateWebhook(payload);
      
      if (!isValid) {
        this.logger.warn(`Invalid private_key for PayID19 webhook: ${payload.id}`);
        console.log('⚠️ Некорректный private_key, отклоняем webhook');
        throw new BadRequestException('Invalid webhook signature');
      }
      
      console.log('✅ PayID19 webhook прошёл проверку подписи!');

      // Обрабатываем webhook
      await this.payid19WebhookService.processWebhook(payload);

      this.logger.log(`✅ Successfully processed root PayID19 webhook for order: ${payload.order_id}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to process root PayID19 webhook:`, error);
      throw error;
    }
  }

  /**
   * Обрабатывает P2PKassa webhook
   */
  private async handleP2PKassaWebhook(
    payload: any,
    headers: any
  ): Promise<{ success: boolean }> {
    this.logger.log(`💳 Received P2PKassa webhook on root path for order: ${payload.order_id}`);
    
    // Логируем полученные данные
    console.log('=== P2PKASSA WEBHOOK ON ROOT PATH ===');
    console.log('Headers:', headers);
    console.log('Parsed Payload:', JSON.stringify(payload, null, 2));
    console.log('======================================');

    try {
      // Проверяем валидность webhook'а (сверяем подпись)
      const isValid = await this.kassaSignatureService.verifyWebhookSignature(payload);
      
      if (!isValid) {
        this.logger.warn(`Invalid signature for P2PKassa webhook: order ${payload.order_id}`);
        console.log('⚠️ Некорректная подпись, отклоняем webhook');
        throw new BadRequestException('Invalid signature');
      }
      
      console.log('✅ P2PKassa webhook прошёл проверку подписи!');

      // Обрабатываем webhook
      await this.kassaWebhookService.processWebhook(payload);

      this.logger.log(`✅ Successfully processed root P2PKassa webhook for order: ${payload.order_id}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to process root P2PKassa webhook:`, error);
      throw error;
    }
  }
}
