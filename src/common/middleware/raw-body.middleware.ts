import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as bodyParser from 'body-parser';

/**
 * Middleware для сохранения raw body запроса
 * Необходимо для корректной проверки RSA подписи webhook'ов
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Проверяем, что это webhook от WATA
    if (req.path.includes('/webhooks/wata')) {
      // Сохраняем raw body в свойстве запроса
      bodyParser.text({ type: '*/*' })(req, res, (err) => {
        if (err) {
          return next(err);
        }
        
        // Сохраняем raw body
        (req as any).rawBody = req.body;
        
        // Парсим JSON для стандартной обработки
        try {
          if (typeof req.body === 'string') {
            req.body = JSON.parse(req.body);
          }
        } catch (parseError) {
          console.error('Failed to parse JSON:', parseError);
          req.body = {};
        }
        
        next();
      });
    } else {
      // Для всех остальных маршрутов используем обычный JSON parser
      bodyParser.json()(req, res, next);
    }
  }
}

// Альтернативная функция middleware (более простая)
export function rawBodyMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.path.includes('/webhooks/wata')) {
      let data = '';
      
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
      });
      
      req.on('end', () => {
        try {
          // Сохраняем raw body
          (req as any).rawBody = data;
          
          // Парсим JSON
          req.body = JSON.parse(data);
          next();
        } catch (error) {
          console.error('Failed to parse webhook JSON:', error);
          req.body = {};
          (req as any).rawBody = data;
          next();
        }
      });
    } else {
      next();
    }
  };
}
