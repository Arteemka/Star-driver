import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface PurchaseData {
  date: string;
  starCount: number;
  isGift: boolean;
  giftRecipient?: string;
}

export interface UserData {
  userId: number;
  username: string;
  firstName?: string;
  lastName?: string;
  firstPurchaseDate: string;
  lastPurchaseDate: string;
  totalPurchases: number;
  totalStars: number;
  isGiftSender?: boolean;
  gifts: {
    sent: number;
    received: number;
  };
  purchases?: PurchaseData[];
  isBlocked?: boolean;  // Флаг заблокированного пользователя
  blockedAt?: string;    // Дата блокировки
}



@Injectable()
export class UserStorageService {
  private readonly logger = AppLogger;
  private readonly dataDir = './data';
  private readonly usersFile = path.join(this.dataDir, 'users.json');
  private users: Map<string, UserData> = new Map();
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  /**
   * Инициализация сервиса и загрузка данных из файла
   */
  private async initialize(): Promise<void> {
    try {
      // Создаем директорию data если её нет
      await fs.mkdir(this.dataDir, { recursive: true });
      
      // Пытаемся загрузить существующие данные
      await this.loadUsers();
      this.isInitialized = true;
      this.logger.log('UserStorageService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize UserStorageService:', error);
      this.users = new Map();
      this.isInitialized = true;
    }
  }

  /**
   * Загружает пользователей из файла
   */
  private async loadUsers(): Promise<void> {
    try {
      const data = await fs.readFile(this.usersFile, 'utf-8');
      const usersArray = JSON.parse(data) as UserData[];
      this.users = new Map(usersArray.map(user => [user.username, user]));
      this.logger.log(`Loaded ${this.users.size} users from storage`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Файл не существует - это нормально при первом запуске
        this.logger.log('Users file does not exist yet, starting with empty storage');
        this.users = new Map();
        await this.saveUsers(); // Создаем пустой файл
      } else {
        throw error;
      }
    }
  }

  /**
   * Сохраняет пользователей в файл
   */
  private async saveUsers(): Promise<void> {
    try {
      const usersArray = Array.from(this.users.values());
      await fs.writeFile(
        this.usersFile, 
        JSON.stringify(usersArray, null, 2), 
        'utf-8'
      );
      this.logger.log(`Saved ${usersArray.length} users to storage`);
    } catch (error) {
      this.logger.error('Failed to save users to file:', error);
      throw error;
    }
  }

  /**
   * Ожидает инициализации сервиса
   */
  private async waitForInitialization(): Promise<void> {
    while (!this.isInitialized) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Добавляет или обновляет пользователя после покупки
   */
  async addOrUpdateUser(
    userId: number,
    username: string,
    starCount: number,
    isGift: boolean = false,
    firstName?: string,
    lastName?: string
  ): Promise<void> {
    await this.waitForInitialization();

    try {
      const cleanUsername = username.replace('@', '');
      const now = new Date().toISOString();
      
      if (this.users.has(cleanUsername)) {
        // Обновляем существующего пользователя
        const user = this.users.get(cleanUsername)!;
        user.lastPurchaseDate = now;
        user.totalPurchases += 1;
        user.totalStars += starCount;
        
        if (isGift) {
          user.isGiftSender = true;
          user.gifts.sent += 1;
        }
        
        if (firstName) user.firstName = firstName;
        if (lastName) user.lastName = lastName;
        
        this.logger.log(`Updated user @${cleanUsername}: purchases=${user.totalPurchases}, stars=${user.totalStars}`);
      } else {
        // Создаем нового пользователя
        const newUser: UserData = {
          userId,
          username: cleanUsername,
          firstName,
          lastName,
          firstPurchaseDate: now,
          lastPurchaseDate: now,
          totalPurchases: 1,
          totalStars: starCount,
          isGiftSender: isGift,
          gifts: {
            sent: isGift ? 1 : 0,
            received: 0
          },
          purchases: []
        };
        
        this.users.set(cleanUsername, newUser);
        this.logger.log(`Added new user @${cleanUsername}`);
      }
      
      // Асинхронно сохраняем в файл
      await this.saveUsers();
    } catch (error) {
      this.logger.error(`Failed to add/update user @${username}:`, error);
      throw error;
    }
  }

  /**
   * Обновляет получателя подарка
   */
  async updateGiftRecipient(username: string): Promise<void> {
    await this.waitForInitialization();
    
    try {
      const cleanUsername = username.replace('@', '');
      
      if (this.users.has(cleanUsername)) {
        const user = this.users.get(cleanUsername)!;
        user.gifts.received += 1;
        await this.saveUsers();
        this.logger.log(`Updated gift recipient @${cleanUsername}: received=${user.gifts.received}`);
      }
      // Если пользователя нет в базе, не создаем его (он появится при первой покупке)
    } catch (error) {
      this.logger.error(`Failed to update gift recipient @${username}:`, error);
    }
  }

  /**
   * Проверяет, существует ли пользователь
   */
  async userExists(username: string): Promise<boolean> {
    await this.waitForInitialization();
    const cleanUsername = username.replace('@', '');
    return this.users.has(cleanUsername);
  }

  /**
   * Получает информацию о пользователе
   */
  async getUser(username: string): Promise<UserData | null> {
    await this.waitForInitialization();
    const cleanUsername = username.replace('@', '');
    return this.users.get(cleanUsername) || null;
  }

  /**
   * Получает всех пользователей
   */
  async getAllUsers(): Promise<UserData[]> {
    await this.waitForInitialization();
    return Array.from(this.users.values());
  }

  /**
   * Получает статистику
   */
  async getStatistics(): Promise<{
    totalUsers: number;
    totalPurchases: number;
    totalStars: number;
    totalGiftsSent: number;
    totalGiftsReceived: number;
    topBuyers: UserData[];
    recentUsers: UserData[];
  }> {
    await this.waitForInitialization();
    
    const users = Array.from(this.users.values());
    
    const stats = {
      totalUsers: users.length,
      totalPurchases: users.reduce((sum, user) => sum + user.totalPurchases, 0),
      totalStars: users.reduce((sum, user) => sum + user.totalStars, 0),
      totalGiftsSent: users.reduce((sum, user) => sum + user.gifts.sent, 0),
      totalGiftsReceived: users.reduce((sum, user) => sum + user.gifts.received, 0),
      topBuyers: users
        .sort((a, b) => b.totalStars - a.totalStars)
        .slice(0, 10),
      recentUsers: users
        .sort((a, b) => new Date(b.lastPurchaseDate).getTime() - new Date(a.lastPurchaseDate).getTime())
        .slice(0, 10)
    };
    
    return stats;
  }

  /**
   * Помечает пользователя как заблокировавшего бота
   */
  async markUserAsBlocked(userId: number): Promise<void> {
    await this.waitForInitialization();
    
    // Находим пользователя по userId
    let userFound = false;
    for (const [username, userData] of this.users.entries()) {
      if (userData.userId === userId) {
        userData.isBlocked = true;
        userData.blockedAt = new Date().toISOString();
        this.users.set(username, userData);
        userFound = true;
        this.logger.log(`User ${userId} (@${username}) marked as blocked`);
        break;
      }
    }
    
    if (!userFound) {
      this.logger.warn(`User ${userId} not found in storage, cannot mark as blocked`);
    }
    
    // Сохраняем изменения
    await this.saveUsers();
  }

  /**
   * Проверяет, заблокирован ли пользователь
   */
  async isUserBlocked(userId: number): Promise<boolean> {
    await this.waitForInitialization();
    
    for (const userData of this.users.values()) {
      if (userData.userId === userId) {
        return userData.isBlocked || false;
      }
    }
    
    return false;
  }

  /**
   * Получает список заблокированных пользователей
   */
  async getBlockedUsers(): Promise<UserData[]> {
    await this.waitForInitialization();
    
    return Array.from(this.users.values())
      .filter(user => user.isBlocked === true);
  }

  /**
   * Снимает блокировку с пользователя
   */
  async unblockUser(userId: number): Promise<void> {
    await this.waitForInitialization();
    
    for (const [username, userData] of this.users.entries()) {
      if (userData.userId === userId) {
        userData.isBlocked = false;
        delete userData.blockedAt;
        this.users.set(username, userData);
        this.logger.log(`User ${userId} (@${username}) unblocked`);
        break;
      }
    }
    
    await this.saveUsers();
  }

  /**
   * Экспортирует данные в CSV формате
   */
  async exportToCSV(): Promise<string> {
    await this.waitForInitialization();
    
    const users = Array.from(this.users.values());
    const headers = [
      'User ID',
      'Username', 
      'First Name',
      'Last Name',
      'First Purchase',
      'Last Purchase',
      'Total Purchases',
      'Total Stars',
      'Gifts Sent',
      'Gifts Received',
      'Is Blocked',
      'Blocked At'
    ];
    
    const rows = users.map(user => [
      user.userId,
      `@${user.username}`,
      user.firstName || '',
      user.lastName || '',
      user.firstPurchaseDate,
      user.lastPurchaseDate,
      user.totalPurchases,
      user.totalStars,
      user.gifts.sent,
      user.gifts.received,
      user.isBlocked ? 'Yes' : 'No',
      user.blockedAt || ''
    ]);
    
    const csv = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');
    
    return csv;
  }
}
