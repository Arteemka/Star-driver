// src/common/constants/payment.constants.ts

/** Идентификаторы callback для inline-кнопок */
export enum CallbackData {
  BUY = 'BUY',
  GIFT = 'GIFT',
  SUPPORT = 'SUPPORT',
}

/** Методы оплаты */
export enum PaymentMethod {
  CRYPTO = '💰 Криптовалюты',
  SBP = 'СБП / Карты РФ',
}

/** Клавиатура с методами оплаты */
export const PAYMENT_KEYBOARD = [
  [PaymentMethod.CRYPTO, PaymentMethod.SBP],
] as const;
