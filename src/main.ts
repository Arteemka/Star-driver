import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLogger } from './utils/logger';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot/bot.service';
import { AdminService } from './bot/admin.service';
import { Telegraf, Context } from 'telegraf';
import { CallbackData } from './common/constants/payment.constants';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AdminScene } from './bot/admin.scene';
import { session } from 'telegraf';
import { Scenes } from 'telegraf';

// Define custom context with session and scene support
interface BotContext extends Context {
  session: Scenes.SceneSession;
  scene: Scenes.SceneContextScene<BotContext>;
}


async function bootstrap(): Promise<void> {
  // Создаем полноценное NestJS приложение с HTTP сервером для webhook'ов
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: AppLogger,
  });
  // Middleware для обработки raw body для WATA webhook'ов
  app.use((req: any, res: any, next: any) => {
    if (req.originalUrl && req.originalUrl.includes('/webhooks/wata')) {
      bodyParser.text({ type: '*/*', limit: '50mb' })(req, res, (err) => {
        if (err) {
          return next(err);
        }

        // Сохраняем raw body в свойстве запроса для проверки подписи
        (req as any).rawBody = req.body;

        // Парсим JSON для дальнейшей обработки
        try {
          if (typeof req.body === 'string') {
            req.body = JSON.parse(req.body);
          }
        } catch (parseError) {
          AppLogger.warn('Failed to parse JSON for WATA webhook', parseError);
        }

        next();
      });
    } else {
      next();
    }
  });

  // Включаем CORS для webhook'ов
  app.enableCors();

  // Запускаем HTTP сервер на порту 3000 для webhook'ов
  const port = process.env.PORT || 3001;
  await app.listen(port);
  AppLogger.log(`🌐 HTTP server started on port ${port} for webhooks`);

  // Получаем сервисы из приложения
  AppLogger.log('🜢 Application context initialized');

  // Клавиатура теперь управляется через BotService
  const config = app.get(ConfigService);
  const botService = app.get(BotService);
  const adminService = app.get(AdminService);

  const token = config.getOrThrow<string>('TELEGRAM_TOKEN');
  const bot = new Telegraf<BotContext>(token);
  
  // Получаем AdminScene из контейнера DI (уже с внедренными зависимостями)
  const adminScene = app.get(AdminScene);
  const stage = new Scenes.Stage<BotContext>([adminScene as any]);
  
  // Подключаем session и stage middleware
  bot.use(session());
  bot.use(stage.middleware());

  // Устанавливаем боковое меню (Menu Button)
  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: 'commands'
    }
  });

  // Устанавливаем команды для бокового меню
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Главное меню' },
    { command: 'buy_stars', description: '⭐ Купить звёзды' },
    { command: 'gift', description: '🎁 Подарить звёзды другу' },
  { command: 'support', description: '💬 Поддержка' },
  ]);

  AppLogger.log('🔧 Menu button and commands configured');

  // Обработка команды /start
  bot.start(async (ctx) => {
    return botService.handleStart(ctx.chat.id);
  });
  // Обработка inline-кнопок через фильтры
  bot.action(CallbackData.BUY, (ctx) => {
    // убираем часы
    ctx.answerCbQuery().catch(() => {});
    return botService.handleCallback(
      ctx.callbackQuery.id,
      CallbackData.BUY,
      ctx.from.id,
    );
  });
  bot.action(CallbackData.GIFT, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return botService.handleCallback(
      ctx.callbackQuery.id,
      CallbackData.GIFT,
      ctx.from.id,
    );
  });

  bot.command('buy_stars', (ctx) => {
    // эмулируем callback без queryId
    return botService.handleCallback('', CallbackData.BUY, ctx.chat.id);
  });

  // Slash-команда /gift
  bot.command('gift', (ctx) => {
    return botService.handleCallback('', CallbackData.GIFT, ctx.chat.id);
  });



  // Команда /support
  bot.command('support', (ctx) => {
    return botService.handleCallback('', CallbackData.SUPPORT, ctx.chat.id);
  });

  // Админские команды - запуск админ-сцены
  bot.command('admin', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    
    if (!adminService.isAdmin(userId, username)) {
      await ctx.reply('❌ У вас нет доступа к админ-панели');
      return;
    }
    
    // Запускаем админ-сцену
    await (ctx as any).scene.enter('admin');
  });

  // Команда для быстрого запуска рассылки (тоже через админ-сцену)
  bot.command('broadcast', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    
    if (!adminService.isAdmin(userId, username)) {
      await ctx.reply('❌ У вас нет доступа к рассылке');
      return;
    }
    
    // Запускаем админ-сцену
    await (ctx as any).scene.enter('admin');
  });

  // Команда /cancel теперь обрабатывается в AdminScene

  bot.command('users', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    
    if (!adminService.isAdmin(userId, username)) {
      await ctx.reply('❌ У вас нет доступа к этой команде');
      return;
    }
    
    const usersData = await adminService.getUsersData();
    if (usersData.users.length === 0) {
      await ctx.reply('📭 Список пользователей пуст');
      return;
    }
    
    // Сортируем по дате (самые новые сверху)
    const sortedUsers = [...usersData.users].sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    
    // Берём последние 20 пользователей
    const recentUsers = sortedUsers.slice(0, 20);
    
    let message = '👥 *Последние 20 пользователей:*\n\n';
    
    recentUsers.forEach((user, index) => {
      const date = new Date(user.timestamp).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const giftEmoji = user.isGift ? '🎁' : '⭐';
      const giftInfo = user.isGift && user.giftRecipient ? ` → @${user.giftRecipient}` : '';
      
      message += `${index + 1}. @${user.username} (${user.starCount} ${giftEmoji}${giftInfo})\n`;
      message += `   _${date}_\n\n`;
    });
    
    if (usersData.users.length > 20) {
      message += `\n_...и ещё ${usersData.users.length - 20} пользователей_`;
    }
    
    await ctx.replyWithMarkdown(message);
  });

  // Обработка фото теперь в AdminScene

  // Обработка всех текстовых сообщений
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // если нажали «⭐ Купить Звёзды» на Reply-клавиатуре
    if (text === '⭐ Купить Звёзды') {
      // пустой queryId, он не нужен для Reply-кнопок
      return botService.handleCallback('', CallbackData.BUY, ctx.chat.id);
    }

    // если нажали «🎁 Купить Другу»
    if (text === '🎁 Сделать Подарок Другу') {
      return botService.handleCallback('', CallbackData.GIFT, ctx.chat.id);
    }
    // если нажали «Поддержка»
    if (text === 'Поддержка') {
      return botService.handleCallback('', CallbackData.SUPPORT, ctx.chat.id);
    }

    // всё остальное в общий текст-флоу
    return botService.handleMessage(ctx.chat.id, text);
  });

  // Сбрасываем вебхук, запускаем polling
  await bot.telegram.deleteWebhook();
  AppLogger.log('🔄 Webhook cleared, starting polling');
  await bot.launch({ dropPendingUpdates: true });
  AppLogger.log('🤖 Bot polling launched');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

bootstrap().catch((err) => AppLogger.error('❌ Bootstrap failed', err));