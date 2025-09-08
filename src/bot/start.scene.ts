import { Injectable, Logger } from '@nestjs/common';
import { Scene, SceneEnter, Ctx } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';

@Scene('start')
@Injectable()
export class StartScene {
  private readonly logger = new Logger(StartScene.name);

  @SceneEnter()
  async onSceneEnter(@Ctx() ctx: Context): Promise<void> {
    this.logger.log('Пользователь начал диалог: /start');
    await ctx.replyWithPhoto(
      {
        url: 'https://briandahlin.github.io/Star-driver/src/common/star-driver.png',
      },
      {
        caption:
          '✨ Добро пожаловать! Здесь вы можете купить Звёзды дешевле, чем в Telegram.\nБез KYC — просто, быстро и удобно.',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⭐ Купить Звёзды', 'BUY')],
          [Markup.button.callback('🎁 Сделать Подарок Другу', 'GIFT')],
        ]),
      },
    );
  }
}
