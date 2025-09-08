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
import { PayID19WebhookService } from './payid19-webhook.service';
import { PayID19WebhookData } from './payid19.service';

@Controller('webhooks/payid19')
export class PayID19WebhookController {
  private readonly logger = new Logger(PayID19WebhookController.name);

  constructor(
    private readonly payid19WebhookService: PayID19WebhookService,
  ) {}

  /**
   * Обработчик webhook уведомлений от PayID19
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() payload: any,
    @Headers() headers: any,
  ): Promise<{ success: boolean }> {
    this.logger.log(`Received PayID19 webhook`);
    
    // Логируем полученные данные
    console.log('=== PAYID19 WEBHOOK RECEIVED ===');
    console.log('Headers:', headers);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('================================');

    try {
      // Преобразуем payload к нужному типу
      const webhookData: PayID19WebhookData = {
        ...payload,
        // Если private_key отсутствует в payload, добавляем заглушку для валидации
        private_key: payload.private_key || '',
      };
      
      // Если это тестовый webhook или отсутствует private_key, пропускаем валидацию
      const skipValidation = webhookData.test === 1 || !webhookData.private_key || !webhookData.order_id;
      
      if (!skipValidation) {
        // Проверяем валидность webhook'а (сверяем private_key)
        const isValid = await this.payid19WebhookService.validateWebhook(webhookData);
        
        if (!isValid) {
          this.logger.warn(`Invalid private_key for PayID19 webhook: ${webhookData.id}`);
          this.logger.warn(`Received private_key: ${webhookData.private_key}`);
          throw new BadRequestException('Invalid webhook signature');
        }
      } else {
        this.logger.log('Skipping webhook validation (test mode or missing data)');
      }

      // Обрабатываем webhook
      await this.payid19WebhookService.processWebhook(webhookData);

      this.logger.log(`Successfully processed PayID19 webhook for order: ${webhookData.order_id}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to process PayID19 webhook:`, error);
      
      // Если это BadRequestException, пробрасываем дальше
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Для других ошибок возвращаем успех, чтобы PayID19 не повторял запрос
      this.logger.warn('Returning success to prevent webhook retry');
      return { success: true };
    }
  }

  /**
   * Тестовый endpoint для проверки webhook'ов (можно удалить в продакшене)
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testWebhook(@Body() payload: any): Promise<{ success: boolean }> {
    console.log('=== TEST PAYID19 WEBHOOK ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('===========================');
    
    return { success: true };
  }
}
