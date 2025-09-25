import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotService } from './bot.service';
import { AdminService } from './admin.service';
import { AdminScene } from './admin.scene';
import { HttpModule } from '@nestjs/axios';
import { FragmentService } from '../payments/fragment.service';
import { WataService } from '../payments/wata.service';
import { PayID19Service } from '../payments/payid19.service';
import { KassaService } from '../payments/kassa.service';

import { TransactionLoggerService } from '../common/services/transaction-logger.service';
import { UserStorageService } from '../common/services/user-storage.service';

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [
    BotService,
    AdminService,
    AdminScene,
    UserStorageService,
    FragmentService,
    WataService,
    PayID19Service,
    KassaService,
    TransactionLoggerService,
  ],
  exports: [
    BotService,
    AdminService,
    AdminScene,
    UserStorageService,
    FragmentService,
    WataService,
    PayID19Service,
    KassaService,
    TransactionLoggerService,
  ],
})
export class BotModule {}
