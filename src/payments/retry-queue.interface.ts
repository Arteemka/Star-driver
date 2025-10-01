/**
 * Интерфейс для очереди повторных попыток заказов
 */

export enum OrderStatus {
  PENDING = 'pending',           // Ожидает обработки
  PROCESSING = 'processing',     // В процессе обработки
  COMPLETED = 'completed',       // Успешно завершён
  FAILED = 'failed',             // Окончательно провален
  RETRYING = 'retrying',         // Повторная попытка
}

export enum FailureReason {
  FRAGMENT_SSL_ERROR = 'fragment_ssl_error',           // SSL ошибки Fragment API
  FRAGMENT_TIMEOUT = 'fragment_timeout',               // Таймаут Fragment API
  FRAGMENT_UNAVAILABLE = 'fragment_unavailable',       // Fragment недоступен
  FRAGMENT_USER_NOT_FOUND = 'fragment_user_not_found', // Пользователь не найден
  FRAGMENT_INSUFFICIENT_BALANCE = 'insufficient_balance', // Недостаточно баланса
  FRAGMENT_RATE_LIMIT = 'rate_limit',                  // Превышен лимит запросов
  UNKNOWN_ERROR = 'unknown_error',                     // Неизвестная ошибка
}

export interface FailedOrder {
  orderId: string;                    // ID заказа
  userId: number;                     // Telegram User ID
  chatId: number;                     // Telegram Chat ID
  recipientUsername: string;          // Username получателя
  starsCount: number;                 // Количество звёзд
  isGift: boolean;                    // Является ли подарком
  
  // Статус и попытки
  status: OrderStatus;                // Текущий статус заказа
  attempts: number;                   // Количество попыток
  maxAttempts: number;                // Максимальное количество попыток
  
  // Информация об ошибке
  failureReason: FailureReason;       // Причина ошибки
  lastError: string;                  // Последняя ошибка
  
  // Временные метки
  createdAt: Date;                    // Время создания заказа
  lastAttemptAt: Date;                // Время последней попытки
  nextRetryAt: Date;                  // Время следующей попытки
  
  // Информация о платеже
  paymentMethod: string;              // Метод оплаты (P2PKassa, PayID19, etc.)
  paymentAmount: number;              // Сумма платежа
  paymentCurrency: string;            // Валюта платежа
  paymentTransactionId: string;       // ID транзакции платежа
  
  // Защита от дублирования
  isProcessing: boolean;              // Флаг обработки (блокировка)
  processingStartedAt?: Date;         // Время начала обработки
  lastSuccessfulFragmentOrderId?: string; // ID успешного Fragment заказа (если есть)
}

/**
 * Конфигурация стратегии повторных попыток
 */
export interface RetryStrategy {
  maxAttempts: number;                // Максимальное количество попыток
  initialDelayMs: number;             // Начальная задержка (мс)
  maxDelayMs: number;                 // Максимальная задержка (мс)
  backoffMultiplier: number;          // Множитель для экспоненциальной задержки
  retryableReasons: FailureReason[];  // Причины, при которых можно повторять
}

/**
 * Результат попытки обработки заказа
 */
export interface RetryResult {
  success: boolean;                   // Успешно ли выполнено
  orderId: string;                    // ID заказа
  fragmentOrderId?: string;           // ID Fragment заказа (если успешно)
  error?: string;                     // Ошибка (если не успешно)
  shouldRetry: boolean;               // Нужно ли повторять
  nextRetryDelay?: number;            // Задержка до следующей попытки (мс)
}
