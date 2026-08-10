import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Обёртка вместо promisify: promisify выбирает перегрузку без options,
 * и параметры стойкости (N, r, p, maxmem) до scrypt не доезжают —
 * молча получился бы хэш с настройками по умолчанию.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) =>
      error ? reject(error) : resolve(derivedKey),
    );
  });
}

/**
 * Хеширование паролей на scrypt из стандартной библиотеки Node.
 *
 * Почему scrypt, а не bcrypt/argon2: обе популярные альтернативы —
 * нативные модули, требующие компиляции при установке. Для open source
 * self-hosted это лишний барьер (нужен toolchain в образе) и лишнее звено
 * в цепочке поставок ради функции, которая уже есть в самом Node.
 *
 * scrypt — memory-hard KDF, рекомендованный RFC 7914; при выбранных
 * параметрах он требует ~32 МБ памяти на проверку, что делает перебор
 * на GPU и ASIC невыгодным.
 */
@Injectable()
export class PasswordService {
  /** 2^15. Компромисс «безопасность / время проверки» ≈ 100 мс на ядре. */
  private static readonly COST = 32768;
  private static readonly BLOCK_SIZE = 8;
  private static readonly PARALLELIZATION = 1;
  private static readonly KEY_LENGTH = 64;
  private static readonly SALT_LENGTH = 16;

  /**
   * maxmem обязателен: значение по умолчанию в Node — 32 МБ, а scrypt при
   * N=32768, r=8 требует 128·N·r ≈ 33,5 МБ и падает с ошибкой.
   */
  private static readonly MAX_MEM = 64 * 1024 * 1024;

  async hash(plain: string): Promise<string> {
    const salt = randomBytes(PasswordService.SALT_LENGTH);
    const derived = await scryptAsync(plain.normalize('NFKC'), salt, PasswordService.KEY_LENGTH, {
      N: PasswordService.COST,
      r: PasswordService.BLOCK_SIZE,
      p: PasswordService.PARALLELIZATION,
      maxmem: PasswordService.MAX_MEM,
    });

    // Параметры хранятся вместе с хэшем: их можно будет усилить, не ломая
    // существующие пароли — старые проверятся своими параметрами.
    return [
      'scrypt',
      PasswordService.COST,
      PasswordService.BLOCK_SIZE,
      PasswordService.PARALLELIZATION,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, costRaw, blockRaw, parRaw, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');

    const derived = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(costRaw),
      r: Number(blockRaw),
      p: Number(parRaw),
      maxmem: PasswordService.MAX_MEM,
    });

    // Сравнение за постоянное время: обычное === завершается на первом
    // различающемся байте и по времени ответа выдаёт длину общего префикса.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  /**
   * Проверка на заведомо слабый пароль.
   * Полноценная политика (словари, утёкшие базы) — задача отдельного шага;
   * здесь минимум, ниже которого опускаться нельзя.
   */
  static validateStrength(plain: string): string | null {
    if (plain.length < 10) return 'пароль короче 10 символов';
    if (!/[a-zа-яё]/i.test(plain)) return 'пароль должен содержать буквы';
    if (!/\d/.test(plain)) return 'пароль должен содержать цифру';
    return null;
  }
}
