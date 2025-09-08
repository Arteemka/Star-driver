import { ConsoleLogger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

class FileLogger extends ConsoleLogger {
  private logFilePath: string;

  constructor(context?: string) {
    super(context || 'App');
    this.logFilePath = path.join(process.cwd(), 'bot.log');
  }

  private writeToFile(level: string, message: any, context?: string) {
    const timestamp = new Date().toLocaleString('ru-RU', { 
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const contextStr = context ? `[${context}]` : '';
    
    // Форматируем сообщение - если это объект, то JSON.stringify
    let formattedMessage: string;
    if (typeof message === 'object' && message !== null) {
      formattedMessage = JSON.stringify(message, null, 2);
    } else {
      formattedMessage = String(message);
    }
    
    const logEntry = `${timestamp} [${level.toUpperCase()}] ${contextStr} ${formattedMessage}\n`;
    
    try {
      fs.appendFileSync(this.logFilePath, logEntry, 'utf8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  // Универсальные методы, совместимые с обоими интерфейсами
  log(message: any, context?: string) {
    // Фильтруем undefined сообщения
    if (message === undefined || message === null) {
      return;
    }
    super.log(message, context);
    this.writeToFile('LOG', message, context);
  }

  // Перегрузки для совместимости с разными сигнатурами error()
  error(message: any, trace?: string | Error | unknown, context?: string) {
    let errorMessage: string;
    let errorContext: string | undefined = context;
    
    if (trace instanceof Error) {
      errorMessage = `${message} - ${trace.message}`;
      if (trace.stack) {
        errorMessage += `\nStack: ${trace.stack}`;
      }
    } else if (typeof trace === 'string') {
      errorMessage = `${message} - ${trace}`;
    } else if (trace && typeof trace === 'object') {
      errorMessage = `${message} - ${JSON.stringify(trace)}`;
    } else {
      errorMessage = String(message);
      // Если trace не передан, возможно это context
      if (typeof trace === 'string' && !context) {
        errorContext = trace;
      }
    }
    
    super.error(errorMessage, errorContext);
    this.writeToFile('ERROR', errorMessage, errorContext);
  }

  warn(message: any, context?: string | unknown) {
    const ctx = typeof context === 'string' ? context : undefined;
    let warnMessage: string;
    
    if (typeof message === 'object' && message !== null) {
      warnMessage = JSON.stringify(message);
    } else {
      warnMessage = String(message);
    }
    
    if (context && typeof context !== 'string') {
      warnMessage += ` - ${JSON.stringify(context)}`;
    }
    
    super.warn(warnMessage, ctx);
    this.writeToFile('WARN', warnMessage, ctx);
  }

  debug(message: any, context?: string | unknown) {
    const ctx = typeof context === 'string' ? context : undefined;
    let debugMessage: string;
    
    if (typeof message === 'object' && message !== null) {
      debugMessage = JSON.stringify(message);
    } else {
      debugMessage = String(message);
    }
    
    if (context && typeof context !== 'string') {
      debugMessage += ` - ${JSON.stringify(context)}`;
    }
    
    super.debug(debugMessage, ctx);
    this.writeToFile('DEBUG', debugMessage, ctx);
  }

  verbose(message: any, context?: string) {
    super.verbose(message, context);
    this.writeToFile('VERBOSE', message, context);
  }
}

export const AppLogger = new FileLogger('Bot');
