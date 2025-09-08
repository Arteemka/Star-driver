import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import NodeRSA = require('node-rsa');

/**
 * Сервис для проверки RSA подписи webhook уведомлений от WATA
 */
@Injectable()
export class WataSignatureService {
  private readonly logger = new Logger(WataSignatureService.name);
  private publicKey: NodeRSA | null = null;
  private publicKeyPem: string | null = null;

  // Предустановленный публичный ключ WATA (из API)
  private readonly WATA_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoL3WIP92OShyu4Y+ecbS\nZJQyU2AW7gbg8X3KqX7dkctQL54kcxvpMySR8UMjZOCSzLuly2BFHP1pNVMPF304\nuIVpRtHtwEw3k3qE259L/7xEJHSzfehHuMlfSng7Lh/HxLW93douDCwohJvAISwF\ncXlqmNo/eJfBu9kQNlclQXFMYLHOtotZbsMM/oAJJvks7bgnN5o9RXMx8SG5rfq/\naK+BZAlEC83HTpnVrv0wpjmeleSPDSiOkWIY6BBTcg1bpH162en9XasJ/xnHLBFY\nkQSjFQw8nN17CFpd5Hkb0QpABgSEVStvaeLHF5XrWi3B/x5v8sUKsEgUnOJ7LnlH\nHQIDAQAB\n-----END PUBLIC KEY-----";

  constructor(private readonly http: HttpService) {}

  /**
   * Получает публичный ключ WATA для проверки подписи
   * Сначала пытается получить с API, при ошибке использует предустановленный ключ
   */
  private async getPublicKey(): Promise<NodeRSA> {
    if (this.publicKey) {
      return this.publicKey;
    }

    let publicKeyPem: string;

    try {
      // Пытаемся получить актуальный ключ с API
      const response = await firstValueFrom(
        this.http.get<{ value: string }>('https://api.wata.pro/api/h2h/public-key'),
      );
      
      publicKeyPem = response.data.value;
      this.logger.log('WATA public key retrieved from API successfully');
    } catch (error) {
      // Используем предустановленный ключ при ошибке
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to retrieve WATA public key from API, using fallback:', errorMessage);
      publicKeyPem = this.WATA_PUBLIC_KEY;
    }

    try {
      // Создаем объект NodeRSA из PEM ключа
      this.publicKey = new NodeRSA(publicKeyPem, 'public');
      
      // Настраиваем параметры для проверки подписи
      this.publicKey.setOptions({
        signingScheme: 'pkcs1-sha512', // PKCS1 с SHA512
      });

      this.publicKeyPem = publicKeyPem;
      this.logger.log('WATA public key loaded successfully');
      
      return this.publicKey;
    } catch (error) {
      this.logger.error('Failed to load WATA public key:', error);
      throw new Error('Could not load WATA public key');
    }
  }

  /**
   * Проверяет подпись webhook'а от WATA используя RSA с SHA512 и PKCS1
   * @param rawBody Сырое тело запроса (raw JSON string)
   * @param signature Подпись из заголовка X-Signature (base64)
   */
  async verifySignature(rawBody: string, signature: string): Promise<boolean> {
    if (!signature) {
      this.logger.warn('No signature provided in webhook');
      return false;
    }

    try {
      const publicKey = await this.getPublicKey();

      // Декодируем подпись из base64
      const signatureBuffer = Buffer.from(signature, 'base64');
      
      // ПО СПЕЦИФИКАЦИИ WATA: проверяем подпись напрямую с raw JSON
      // RSA с SHA512 делает хеширование внутренне, не нужно хешировать заранее
      const isValid = publicKey.verify(Buffer.from(rawBody, 'utf8'), signatureBuffer);
      
      this.logger.log(`Signature verification result: ${isValid}`);
      
      if (!isValid) {
        // Дополнительная отладочная информация
        this.logger.debug('Signature verification failed');
        this.logger.debug(`Raw body length: ${rawBody.length}`);
        this.logger.debug(`Raw body preview: ${rawBody.substring(0, 100)}...`);
        this.logger.debug(`Signature length: ${signature.length}`);
        this.logger.debug(`Decoded signature length: ${signatureBuffer.length}`);
        
        // Дополнительный отладочный вывод
        this.logger.debug(`Raw body (первые 200 символов): ${rawBody.substring(0, 200)}`);
      }
      
      return isValid;
    } catch (error) {
      this.logger.error('Error verifying signature:', error);
      return false;
    }
  }

  /**
   * Альтернативный метод проверки подписи (для отладки)
   * Использует встроенный crypto модуль Node.js
   */
  async verifySignatureCrypto(rawBody: string, signature: string): Promise<boolean> {
    if (!signature) {
      return false;
    }

    try {
      const { createVerify } = await import('crypto');
      
      let publicKeyPem: string;
      
      if (this.publicKeyPem) {
        publicKeyPem = this.publicKeyPem;
      } else {
        // Получаем ключ если еще не загружен
        await this.getPublicKey();
        publicKeyPem = this.publicKeyPem!;
      }

      const verifier = createVerify('RSA-SHA512');
      verifier.update(rawBody, 'utf8');
      
      const isValid = verifier.verify(publicKeyPem, signature, 'base64');
      
      this.logger.log(`Crypto signature verification result: ${isValid}`);
      return isValid;
    } catch (error) {
      this.logger.error('Error verifying signature with crypto:', error);
      return false;
    }
  }

  /**
   * Проверяет подпись webhook'а используя оба метода (для отладки)
   */
  async verifySignatureDebug(rawBody: string, signature: string): Promise<{
    nodeRsaResult: boolean;
    cryptoResult: boolean;
    isValid: boolean;
  }> {
    const nodeRsaResult = await this.verifySignature(rawBody, signature);
    const cryptoResult = await this.verifySignatureCrypto(rawBody, signature);
    
    const isValid = nodeRsaResult || cryptoResult;
    
    this.logger.debug(`Signature verification debug:`, {
      nodeRsaResult,
      cryptoResult,
      isValid,
    });

    return {
      nodeRsaResult,
      cryptoResult,
      isValid,
    };
  }
}
