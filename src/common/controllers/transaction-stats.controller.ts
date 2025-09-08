import { Controller, Get, Logger } from '@nestjs/common';
import { TransactionLoggerService } from '../services/transaction-logger.service';

@Controller('admin/transactions')
export class TransactionStatsController {
  private readonly logger = new Logger(TransactionStatsController.name);

  constructor(private readonly transactionLogger: TransactionLoggerService) {}

  /**
   * Получает статистику по всем транзакциям
   */
  @Get('stats')
  async getTransactionStats() {
    try {
      const stats = await this.transactionLogger.getTransactionStats();
      
      this.logger.log('Transaction stats requested');
      
      return {
        success: true,
        data: stats,
        message: 'Transaction statistics retrieved successfully',
      };
    } catch (error) {
      this.logger.error('Failed to get transaction stats:', error);
      return {
        success: false,
        error: 'Failed to retrieve transaction statistics',
      };
    }
  }

  /**
   * Получает красиво отформатированную статистику для просмотра в браузере
   */
  @Get('stats/html')
  async getTransactionStatsHtml() {
    try {
      const stats = await this.transactionLogger.getTransactionStats();
      
      const successRate = stats.total > 0 ? ((stats.paid / stats.total) * 100).toFixed(1) : '0.0';
      const averageAmount = stats.paid > 0 ? (stats.totalAmount / stats.paid).toFixed(2) : '0.00';
      const averageStars = stats.paid > 0 ? (stats.totalStars / stats.paid).toFixed(0) : '0';
      
      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Статистика транзакций Star-driver</title>
        <meta charset="utf-8">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            margin: 40px; 
            background: #f5f5f5; 
          }
          .container { 
            max-width: 800px; 
            margin: 0 auto; 
            background: white; 
            padding: 30px; 
            border-radius: 10px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
          }
          h1 { 
            color: #333; 
            text-align: center; 
            margin-bottom: 30px; 
            font-size: 2em;
          }
          .stat-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px; 
          }
          .stat-card { 
            background: #f8f9fa; 
            padding: 20px; 
            border-radius: 8px; 
            text-align: center; 
            border-left: 4px solid #007bff; 
          }
          .stat-card.success { border-left-color: #28a745; }
          .stat-card.danger { border-left-color: #dc3545; }
          .stat-card.warning { border-left-color: #ffc107; }
          .stat-card.info { border-left-color: #17a2b8; }
          .stat-value { 
            font-size: 2em; 
            font-weight: bold; 
            margin-bottom: 5px; 
          }
          .stat-label { 
            color: #666; 
            font-size: 0.9em; 
            text-transform: uppercase; 
            letter-spacing: 0.5px; 
          }
          .refresh-info { 
            text-align: center; 
            color: #666; 
            font-size: 0.9em; 
            margin-top: 20px; 
          }
          .emoji { font-size: 1.5em; margin-right: 10px; }
          .footer { 
            text-align: center; 
            margin-top: 30px; 
            padding-top: 20px; 
            border-top: 1px solid #eee; 
            color: #999; 
            font-size: 0.8em; 
          }
        </style>
        <meta http-equiv="refresh" content="30">
      </head>
      <body>
        <div class="container">
          <h1>📊 Статистика транзакций</h1>
          
          <div class="stat-grid">
            <div class="stat-card">
              <div class="stat-value">${stats.total}</div>
              <div class="stat-label"><span class="emoji">📊</span>Всего транзакций</div>
            </div>
            
            <div class="stat-card success">
              <div class="stat-value">${stats.paid}</div>
              <div class="stat-label"><span class="emoji">✅</span>Успешных</div>
            </div>
            
            <div class="stat-card danger">
              <div class="stat-value">${stats.declined}</div>
              <div class="stat-label"><span class="emoji">❌</span>Отклонённых</div>
            </div>
            
            <div class="stat-card warning">
              <div class="stat-value">${stats.error}</div>
              <div class="stat-label"><span class="emoji">🚨</span>Ошибок обработки</div>
            </div>
            
            <div class="stat-card info">
              <div class="stat-value">${successRate}%</div>
              <div class="stat-label"><span class="emoji">📈</span>Успешность</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-value">${stats.totalAmount.toFixed(2)} ₽</div>
              <div class="stat-label"><span class="emoji">💰</span>Общая сумма</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-value">${averageAmount} ₽</div>
              <div class="stat-label"><span class="emoji">📊</span>Средний чек</div>
            </div>
            
            <div class="stat-card success">
              <div class="stat-value">${stats.totalStars}</div>
              <div class="stat-label"><span class="emoji">⭐</span>Звёзд продано</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-value">${averageStars}</div>
              <div class="stat-label"><span class="emoji">⭐</span>Звёзд в среднем</div>
            </div>
          </div>
          
          <div class="refresh-info">
            🔄 Данные обновляются автоматически каждые 30 секунд<br>
            📅 Последнее обновление: ${new Date().toLocaleString('ru-RU')}
          </div>
          
          <div class="footer">
            Star-driver Bot Transaction Monitor<br>
            Powered by WATA & Fragment API
          </div>
        </div>
      </body>
      </html>
      `;
      
      return html;
    } catch (error) {
      this.logger.error('Failed to generate transaction stats HTML:', error);
      return `
        <html><body>
          <h1>Ошибка</h1>
          <p>Не удалось загрузить статистику транзакций: ${(error as Error)?.message || 'Неизвестная ошибка'}</p>
        </body></html>
      `;
    }
  }
}
