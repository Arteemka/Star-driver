/** Минимальное число звёзд для покупки или подарка (Fragment API требует минимум 50) */
export const MIN_STARS = 100;

/** Цена одной звезды в рублях */
export const STAR_PRICE_RUB = 1.45;

/** Цена одной звезды в USD для криптоплатежей */
export const STAR_PRICE_USD = 0.0180;

/** Поддерживаемые валюты */
export enum Currency {
  RUB = 'RUB',
  USD = 'USD',
}

/** Подпись для /start */
export const START_CAPTION =
  '✨ Добро пожаловать! Здесь вы можете купить Звёзды дешевле, чем в Telegram.\nБез KYC — просто, быстро и удобно.';
