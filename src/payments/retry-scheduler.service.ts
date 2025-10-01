import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RetryQueueService } from './retry-queue.service';

/**
 * Планировщик для автоматической обработки очереди повторных попыток
 */
@Injectable()
export class RetrySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RetrySchedulerService.name);
  private isProcessing = false;

  constructor(private readonly retryQueueService: RetryQueueService) {}

  /**
   * Инициализация при запуске модуля
   */
  async onModuleInit() {
    this.logger.log('🚀 Планировщик повторных попыток инициализирован');
    this.logger.log('📅 Обработка очереди будет выполняться каждые 2 минуты');
    
    // Показываем статистику при запуске
    await this.logQueueStats();
  }

  /**
   * Запускается каждые 2 минуты
   * Обрабатывает очередь неудавшихся заказов
   */
  @Cron('*/2 * * * *', {
    name: 'process-retry-queue',
  })
  async handleRetryQueue() {
    // Защита от одновременного выполнения
    if (this.isProcessing) {
      this.logger.warn('⚠️ Обработка очереди уже выполняется, пропускаем...');
      return;
    }

    this.isProcessing = true;

    try {
      this.logger.log('\n⏰ Запуск обработки очереди повторных попыток...');
      
      // Обрабатываем очередь
      await this.retryQueueService.processRetryQueue();
      
      // Показываем статистику после обработки
      await this.logQueueStats();
      
    } catch (error) {
      this.logger.error('❌ Ошибка при обработке очереди:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Очистка старых завершённых заказов
   * Запускается каждый день в 3:00 ночи
   */
  @Cron('0 3 * * *', {
    name: 'cleanup-old-orders',
  })
  async handleCleanup() {
    try {
      this.logger.log('\n🧹 Запуск очистки старых заказов...');
      
      const removedCount = await this.retryQueueService.cleanupOldOrders(7);
      
      if (removedCount > 0) {
        this.logger.log(`✅ Очищено ${removedCount} старых заказов`);
      } else {
        this.logger.log('✅ Нет старых заказов для очистки');
      }
      
    } catch (error) {
      this.logger.error('❌ Ошибка при очистке старых заказов:', error);
    }
  }

  /**
   * Выводит статистику очереди в лог
   */
  private async logQueueStats() {
    try {
      const stats = await this.retryQueueService.getQueueStats();
      
      this.logger.log('\n' + '='.repeat(50));
      this.logger.log('📊 СТАТИСТИКА ОЧЕРЕДИ ПОВТОРНЫХ ПОПЫТОК:');
      this.logger.log(`   Всего заказов: ${stats.total}`);
      this.logger.log(`   ⏳ Ожидают повтора: ${stats.pending}`);
      this.logger.log(`   🔄 В обработке: ${stats.processing + stats.retrying}`);
      this.logger.log(`   ✅ Завершено: ${stats.completed}`);
      this.logger.log(`   ❌ Провалено: ${stats.failed}`);
      this.logger.log('='.repeat(50) + '\n');
    } catch (error) {
      this.logger.error('Ошибка при получении статистики:', error);
    }
  }
}
