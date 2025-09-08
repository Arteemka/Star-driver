import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { HttpModule } from '@nestjs/axios';
import { BotModule } from './bot/bot.module';
import { WataWebhookController } from './payments/wata-webhook.controller';
import { WataWebhookService } from './payments/wata-webhook.service';
import { WataSignatureService } from './payments/wata-signature.service';
import { FragmentService } from './payments/fragment.service';
import { PayID19Service } from './payments/payid19.service';
import { PayID19WebhookController } from './payments/payid19-webhook.controller';
import { PayID19WebhookService } from './payments/payid19-webhook.service';
import { KassaService } from './payments/kassa.service';
import { KassaWebhookController } from './payments/kassa-webhook.controller';
import { KassaWebhookService } from './payments/kassa-webhook.service';
import { KassaSignatureService } from './payments/kassa-signature.service';

import { RootWebhookController } from './root-webhook.controller';
import { TransactionLoggerService } from './common/services/transaction-logger.service';
import { TransactionStatsController } from './common/controllers/transaction-stats.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        TELEGRAM_TOKEN: Joi.string().required(),
        FRAGMENT_API_KEY: Joi.string().required(),
        FRAGMENT_PHONE_NUMBER: Joi.string().required(),
        FRAGMENT_MNEMONICS: Joi.string().required(),
        KASSA_API_KEY: Joi.string().required(),
        KASSA_PROJECT_ID: Joi.string().required(),
        KASSA_API_URL: Joi.string().uri().optional(),
        WATA_ACCESS_TOKEN: Joi.string().required(),
        WATA_API_URL: Joi.string().uri(),
        PAYID19_PUBLIC_KEY: Joi.string().required(),
        PAYID19_PRIVATE_KEY: Joi.string().required(),
       
        BANNER_URL: Joi.string().uri().required(),
        WEBHOOK_BASE_URL: Joi.string().uri().optional(),
      }),
    }),
    HttpModule,
    BotModule,
    
  ],
  controllers: [WataWebhookController, PayID19WebhookController, KassaWebhookController, RootWebhookController, TransactionStatsController],
  providers: [
    WataWebhookService, 
    WataSignatureService, 
    FragmentService, 
    PayID19Service, 
    PayID19WebhookService,
    KassaService,
    KassaWebhookService,
    KassaSignatureService,
    TransactionLoggerService
  ],
})
export class AppModule {}
