import { Injectable } from '@nestjs/common';
import { Markup, Scenes } from 'telegraf';
import { AdminService } from './admin.service';
import { AppLogger } from '../utils/logger';

// Состояния админ-меню
enum AdminState {
  MAIN_MENU = 'main_menu',
  WAITING_BROADCAST = 'waiting_broadcast',
  CONFIRM_BROADCAST = 'confirm_broadcast'
}

interface BroadcastContent {
  text?: string;
  photo?: string; // file_id фотографии
  caption?: string; // подпись к фото
  type: 'text' | 'photo';
}

interface AdminSession extends Scenes.SceneSession {
  adminState?: AdminState;
  broadcastContent?: BroadcastContent;
}

interface AdminSceneContext extends Scenes.SceneContext {
  session: AdminSession;
}

@Injectable()
export class AdminScene extends Scenes.BaseScene<AdminSceneContext> {
  private readonly logger = AppLogger;

  constructor(
    private readonly adminService: AdminService
  ) {
    super('admin');
    this.setupHandlers();
  }

  private setupHandlers(): void {

    // Обработка входа в сцену
    this.enter(async (ctx: AdminSceneContext) => {
      const userId = ctx.from?.id;
      const username = ctx.from?.username;

      // Проверяем права админа
      if (!userId || !this.adminService.isAdmin(userId, username)) {
        await ctx.reply('❌ У вас нет прав администратора');
        await ctx.scene.leave();
        return;
      }

      this.logger.log(`Admin ${username} (${userId}) entered admin panel`);
      await this.showMainMenu(ctx);
    });

    // Обработка кнопок
    this.action('admin_broadcast', async (ctx: AdminSceneContext) => {
      await this.onBroadcast(ctx);
    });

    this.action('admin_exit', async (ctx: AdminSceneContext) => {
      await this.onExit(ctx);
    });

    this.action('admin_send_broadcast', async (ctx: AdminSceneContext) => {
      await this.onSendBroadcast(ctx);
    });

    this.action('admin_back', async (ctx: AdminSceneContext) => {
      await this.onBack(ctx);
    });

    // Обработка текста
    this.on('text', async (ctx: AdminSceneContext) => {
      await this.onText(ctx);
    });

    // Обработка фото
    this.on('photo', async (ctx: AdminSceneContext) => {
      await this.onPhoto(ctx);
    });

    // Обработка команды /admin
    this.command('admin', async (ctx: AdminSceneContext) => {
      await this.onAdminCommand(ctx);
    });
  }

  /**
   * Показать главное меню админки
   */
  private async showMainMenu(ctx: AdminSceneContext): Promise<void> {
    ctx.session.adminState = AdminState.MAIN_MENU;
    
    const stats = await this.adminService.getStats();
    
    const menuText = `🔧 **Админ панель**\n\n` +
      `📊 **Статистика:**\n` +
      `Всего пользователей: ${stats.total}\n` +
      `Сегодня: ${stats.today}\n` +
      `За неделю: ${stats.thisWeek}\n\n` +
      `Выберите действие:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📢 Рассылка', 'admin_broadcast')],
      [Markup.button.callback('❌ Выход', 'admin_exit')]
    ]);

    try {
      await ctx.editMessageText(menuText, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    } catch {
      await ctx.reply(menuText, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    }
  }

  async onBroadcast(ctx: AdminSceneContext): Promise<void> {
    ctx.session.adminState = AdminState.WAITING_BROADCAST;
    ctx.session.broadcastContent = undefined;
    
    await ctx.editMessageText(
      '📢 **Режим рассылки**\n\n' +
      '📝 Отправьте сообщение для рассылки всем пользователям:\n' +
      '• Текстовое сообщение (поддерживается Markdown)\n' +
      '• Фотографию (с подписью или без)\n\n' +
      '❌ Отправьте /cancel для отмены',
      { parse_mode: 'Markdown' }
    );
  }

  async onExit(ctx: AdminSceneContext): Promise<void> {
    await ctx.editMessageText('👋 Вы вышли из админ-панели');
    await ctx.scene.leave();
  }

  async onText(ctx: AdminSceneContext): Promise<void> {
    const text = (ctx.message as any)?.text;
    
    if (!text) return;
    
    // Обработка команды отмены
    if (text === '/cancel') {
      await ctx.reply('❌ Действие отменено');
      await this.showMainMenu(ctx);
      return;
    }
    
    switch (ctx.session.adminState) {
      case AdminState.WAITING_BROADCAST:
        await this.handleBroadcastText(ctx, text);
        break;
        
      default:
        // Игнорируем текст в других состояниях
        break;
    }
  }

  async onPhoto(ctx: AdminSceneContext): Promise<void> {
    if (ctx.session.adminState === AdminState.WAITING_BROADCAST) {
      await this.handleBroadcastPhoto(ctx);
    }
  }

  /**
   * Обработка текстового сообщения для рассылки
   */
  private async handleBroadcastText(ctx: AdminSceneContext, text: string): Promise<void> {
    ctx.session.broadcastContent = {
      text,
      type: 'text'
    };
    ctx.session.adminState = AdminState.CONFIRM_BROADCAST;
    
    await this.showBroadcastConfirmation(ctx);
  }

  /**
   * Обработка фотографии для рассылки
   */
  private async handleBroadcastPhoto(ctx: AdminSceneContext): Promise<void> {
    const message = ctx.message as any;
    if (!message?.photo) return;
    
    // Берем фото самого высокого качества
    const photo = message.photo[message.photo.length - 1];
    const caption = message.caption || '';
    
    ctx.session.broadcastContent = {
      photo: photo.file_id,
      caption,
      type: 'photo'
    };
    ctx.session.adminState = AdminState.CONFIRM_BROADCAST;
    
    await this.showBroadcastConfirmation(ctx);
  }

  /**
   * Показать подтверждение рассылки
   */
  private async showBroadcastConfirmation(ctx: AdminSceneContext): Promise<void> {
    const content = ctx.session.broadcastContent;
    if (!content) return;
    
    const stats = await this.adminService.getStats();
    
    let previewText = '📢 **Подтверждение рассылки**\n\n' +
      `Сообщение будет отправлено **${stats.total}** пользователям.\n\n`;
    
    if (content.type === 'text') {
      previewText += `**Предпросмотр текста:**\n\n${content.text}\n\n`;
    } else {
      previewText += `**Предпросмотр:** Фотография${content.caption ? ' с подписью' : ''}\n\n`;
      if (content.caption) {
        previewText += `**Подпись:** ${content.caption}\n\n`;
      }
    }
    
    previewText += 'Выберите действие:';
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Отправить', 'admin_send_broadcast')],
      [Markup.button.callback('❌ Отмена', 'admin_back')]
    ]);
    
    // Если это фото, показываем его в предпросмотре
    if (content.type === 'photo') {
      try {
        await ctx.replyWithPhoto(content.photo!, {
          caption: previewText,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } catch {
        // Если не удалось отправить фото, отправляем текст
        await ctx.reply(previewText, {
          parse_mode: 'Markdown',
          ...keyboard
        });
      }
    } else {
      await ctx.reply(previewText, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    }
  }

  async onSendBroadcast(ctx: AdminSceneContext): Promise<void> {
    await this.executeBroadcast(ctx, false);
  }

  async onBack(ctx: AdminSceneContext): Promise<void> {
    await this.showMainMenu(ctx);
  }

  /**
   * Выполнение рассылки
   */
  private async executeBroadcast(ctx: AdminSceneContext, includeButtons: boolean = false): Promise<void> {
    const content = ctx.session.broadcastContent;
    
    if (!content) {
      await ctx.reply('❌ Контент для рассылки не найден');
      await this.showMainMenu(ctx);
      return;
    }
    
    await ctx.reply('⏳ Начинаю рассылку...');
    
    let result;
    
    if (content.type === 'text') {
      // Рассылка текста
      result = await this.adminService.broadcast(content.text!, {
        parseMode: 'Markdown',
        includeButtons
      });
    } else {
      // Рассылка фото
      result = await this.adminService.broadcast(content.caption || '', {
        parseMode: 'Markdown',
        includeButtons,
        photo: content.photo
      });
    }
    
    const resultText = `✅ **Рассылка завершена**\n\n` +
      `✅ Успешно отправлено: ${result.success}\n` +
      `❌ Ошибок: ${result.failed}`;
    
    // Показываем детали ошибок, если они есть
    if (result.failed > 0 && result.errors.length > 0) {
      const errorSample = result.errors.slice(0, 3).join('\n');
      await ctx.reply(
        resultText + `\n\n**Примеры ошибок:**\n\`\`\`\n${errorSample}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(resultText, { parse_mode: 'Markdown' });
    }
    
    ctx.session.broadcastContent = undefined;
    ctx.session.adminState = AdminState.MAIN_MENU;
    
    await this.showMainMenu(ctx);
  }

  async onAdminCommand(ctx: AdminSceneContext): Promise<void> {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!userId || !this.adminService.isAdmin(userId, username)) {
      await ctx.reply('❌ У вас нет прав администратора');
      return;
    }

    await ctx.scene.enter('admin');
  }
}
