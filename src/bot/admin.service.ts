import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegram } from 'telegraf';
import { AppLogger } from '../utils/logger';
import { UserStorageService } from '../common/services/user-storage.service';

@Injectable()
export class AdminService {
  private readonly logger = AppLogger;
  private readonly tg: Telegram;
  private readonly adminId: number;
  private readonly adminUsername: string;

  constructor(
    private readonly config: ConfigService,
    private readonly userStorageService: UserStorageService
  ) {
    const token = this.config.getOrThrow<string>('TELEGRAM_TOKEN');
    this.tg = new Telegram(token);
    
    // Получаем админские данные из .env
    this.adminId = parseInt(this.config.getOrThrow<string>('ADMIN_ID'));
    this.adminUsername = this.config.getOrThrow<string>('ADMIN_USERNAME');
    
    this.logger.log('Admin service initialized');
  }

  /**
   * Проверка является ли пользователь администратором
   */
  isAdmin(userId: number, username?: string): boolean {
    const isAdminById = userId === this.adminId;
    const isAdminByUsername = username ? username === this.adminUsername : false;
    
    this.logger.log(`Admin check for user ${userId} (@${username}): ${isAdminById || isAdminByUsername}`);
    
    return isAdminById || isAdminByUsername;
  }

  /**
   * Проверка существования username
   */
  async isUsernameExists(username: string): Promise<boolean> {
    if (!username) return false;
    return await this.userStorageService.userExists(username);
  }

  /**
   * Добавление пользователя при показе оплаты
   */
  async addUserOnPaymentOffer(user: {
    username?: string;
    userId: number;
    chatId: number;
    starCount: number;
    isGift?: boolean;
    giftRecipient?: string;
  }): Promise<boolean> {
    try {
      const username = user.username || `user_${user.userId}`;
      
      // Добавляем в UserStorageService
      await this.userStorageService.addOrUpdateUser(
        user.userId,
        username,
        user.starCount,
        user.isGift || false
      );
      
      return true;
    } catch (error) {
      this.logger.error('Failed to add user on payment offer:', error);
      return false;
    }
  }

  /**
   * Получение статистики по пользователям
   */
  async getStats(): Promise<{ 
    total: number; 
    today: number; 
    thisWeek: number; 
    thisMonth: number;
    totalStars: number;
    gifts: number;
    uniqueUsernames: number;
  }> {
    // Получаем статистику из UserStorageService
    const storageStats = await this.userStorageService.getStatistics();
    const users = await this.userStorageService.getAllUsers();
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    // Подсчитываем пользователей по периодам
    let todayCount = 0;
    let weekCount = 0;
    let monthCount = 0;
    
    users.forEach(user => {
      const lastPurchase = new Date(user.lastPurchaseDate);
      if (lastPurchase >= today) todayCount++;
      if (lastPurchase >= weekAgo) weekCount++;
      if (lastPurchase >= monthAgo) monthCount++;
    });
    
    return {
      total: storageStats.totalUsers,
      today: todayCount,
      thisWeek: weekCount,
      thisMonth: monthCount,
      totalStars: storageStats.totalStars,
      gifts: storageStats.totalGiftsSent,
      uniqueUsernames: storageStats.totalUsers
    };
  }

  /**
   * Массовая рассылка сообщений пользователям
   */
  async broadcast(message: string, options?: {
    parseMode?: 'Markdown' | 'HTML';
    includeButtons?: boolean;
    photo?: string;
    testMode?: boolean;
  }): Promise<{
    success: number;
    failed: number;
    errors: string[];
  }> {
    // Получаем пользователей из UserStorageService
    const storageUsers = await this.userStorageService.getAllUsers();
    
    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };
    
    // В Telegram userId и chatId для личных чатов совпадают
    const recipients = storageUsers.map(user => ({
      userId: user.userId,
      username: user.username,
      chatId: user.userId // используем userId как chatId
    }));
    
    // В тестовом режиме отправляем только админу
    const finalRecipients = options?.testMode 
      ? recipients.filter(u => u.userId === this.adminId)
      : recipients;
    
    if (finalRecipients.length === 0) {
      // Если нет получателей
      if (options?.testMode) {
        // В тестовом режиме всё равно отправляем админу
        try {
          const messageOptions: any = {};
          
          if (options?.parseMode) {
            messageOptions.parse_mode = options.parseMode;
          }
          
          if (options?.includeButtons) {
            messageOptions.reply_markup = {
              inline_keyboard: [
                [{ text: '⭐ Купить Звёзды', callback_data: 'BUY' }],
                [{ text: '🎁 Сделать Подарок', callback_data: 'GIFT' }]
              ]
            };
          }
          
          if (options?.photo) {
            await this.tg.sendPhoto(this.adminId, options.photo, {
              caption: message,
              ...messageOptions
            });
          } else {
            await this.tg.sendMessage(this.adminId, message, messageOptions);
          }
          
          results.success = 1;
          this.logger.log('Test message sent to admin');
          return results;
        } catch (error) {
          results.failed = 1;
          results.errors.push(`Failed to send test message to admin: ${error}`);
          return results;
        }
      } else {
        this.logger.warn('No users found for broadcast');
        return results;
      }
    }
    
    this.logger.log(`Starting broadcast to ${finalRecipients.length} users${options?.testMode ? ' (TEST MODE)' : ''}`);
    
    // Счетчики для блокированных пользователей
    let blockedUsers = 0;
    const blockedUsersList: string[] = [];
    
    for (const user of finalRecipients) {
      const messageOptions: any = {};
      
      if (options?.parseMode) {
        messageOptions.parse_mode = options.parseMode;
      }
      
      if (options?.includeButtons) {
        messageOptions.reply_markup = {
          inline_keyboard: [
            [{ text: '⭐ Купить Звёзды', callback_data: 'BUY' }],
            [{ text: '🎁 Сделать Подарок', callback_data: 'GIFT' }]
          ]
        };
      }
      
      try {
        // Задержка между сообщениями чтобы не превысить лимиты Telegram
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Используем userId как chatId (они совпадают для личных чатов)
        const targetChatId = user.chatId || user.userId;
        
        if (options?.photo) {
          await this.tg.sendPhoto(targetChatId, options.photo, {
            caption: message,
            ...messageOptions
          });
        } else {
          await this.tg.sendMessage(targetChatId, message, messageOptions);
        }
        
        results.success++;
        this.logger.log(`Message sent to @${user.username} (${targetChatId})`);
      } catch (error: any) {
        const errorMessage = error.message || error.toString();
        
        // Обработка заблокированных пользователей
        if (
          error.code === 403 || 
          errorMessage.includes('bot was blocked') ||
          errorMessage.includes('user is deactivated') ||
          errorMessage.includes('Forbidden') ||
          errorMessage.includes('chat not found') ||
          errorMessage.includes('PEER_ID_INVALID')
        ) {
          blockedUsers++;
          blockedUsersList.push(`@${user.username || 'unknown'} (${user.userId})`);
          this.logger.log(`User blocked bot: @${user.username} (${user.userId}) - skipping`);
          
          // Помечаем пользователя как заблокированного
          try {
            await this.userStorageService.markUserAsBlocked(user.userId);
          } catch (markError) {
            this.logger.warn(`Failed to mark user ${user.userId} as blocked:`, markError);
          }
        } 
        // Обработка слишком частых запросов
        else if (
          error.code === 429 || 
          errorMessage.includes('Too Many Requests') ||
          errorMessage.includes('retry after')
        ) {
          const retryAfter = error.parameters?.retry_after || 60;
          this.logger.warn(`Rate limit hit. Waiting ${retryAfter} seconds...`);
          
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          
          // Пробуем отправить еще раз
          try {
            if (options?.photo) {
              await this.tg.sendPhoto(user.chatId || user.userId, options.photo, {
                caption: message,
                ...messageOptions
              });
            } else {
              await this.tg.sendMessage(user.chatId || user.userId, message, messageOptions);
            }
            results.success++;
            this.logger.log(`Message sent to @${user.username} after retry`);
          } catch (retryError) {
            results.failed++;
            const errorMsg = `Failed to send to @${user.username} after retry: ${retryError}`;
            results.errors.push(errorMsg);
            this.logger.error(errorMsg);
          }
        } 
        // Другие ошибки
        else {
          results.failed++;
          const errorMsg = `Failed to send to @${user.username} (${user.userId}): ${errorMessage}`;
          results.errors.push(errorMsg);
          this.logger.error(errorMsg);
        }
      }
    }
    
    // Информация о заблокированных пользователях
    if (blockedUsers > 0) {
      this.logger.log(`Blocked users: ${blockedUsers}`);
      if (blockedUsersList.length <= 10) {
        this.logger.log(`Blocked users list: ${blockedUsersList.join(', ')}`);
      } else {
        this.logger.log(`First 10 blocked users: ${blockedUsersList.slice(0, 10).join(', ')} and ${blockedUsersList.length - 10} more`);
      }
      results.errors.unshift(`🚫 Заблокировали бота: ${blockedUsers} пользователей`);
    }
    
    this.logger.log(`Broadcast completed: ${results.success} success, ${results.failed} failed, ${blockedUsers} blocked`);
    
    return results;
  }

  /**
   * Получение данных о пользователях
   */
  async getUsersData(): Promise<{
    users: Array<{
      username: string;
      starCount: number;
      isGift: boolean;
      giftRecipient?: string;
      timestamp: string;
    }>;
  }> {
    const storageUsers = await this.userStorageService.getAllUsers();
    
    const users = storageUsers.map(user => ({
      username: user.username,
      starCount: user.totalStars,
      isGift: user.gifts.sent > 0,
      giftRecipient: undefined, // Можно добавить логику для определения получателя подарка
      timestamp: user.lastPurchaseDate
    }));
    
    return { users };
  }
  
  /**
   * Экспорт списка пользователей в текстовый формат
   */
  async exportUsers(): Promise<string> {
    const users = await this.userStorageService.getAllUsers();
    const lines = ['📊 Users list:', ''];
    
    // Сортируем по дате последней покупки
    const sortedUsers = [...users].sort((a, b) => 
      new Date(b.lastPurchaseDate).getTime() - new Date(a.lastPurchaseDate).getTime()
    );
    
    sortedUsers.forEach(user => {
      const stars = ` | Stars: ${user.totalStars}`;
      const purchases = ` | Purchases: ${user.totalPurchases}`;
      const gifts = user.gifts.sent > 0 ? ` | Gifts sent: ${user.gifts.sent}` : '';
      lines.push(`@${user.username} - ID: ${user.userId} - Date: ${new Date(user.lastPurchaseDate).toLocaleString()}${stars}${purchases}${gifts}`);
    });
    
    lines.push('');
    lines.push(`Total users: ${users.length}`);
    
    return lines.join('\n');
  }
}
