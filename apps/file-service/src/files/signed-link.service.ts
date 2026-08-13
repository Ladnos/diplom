import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FILE_CONFIG, type FileConfig } from '../config';

/**
 * Ссылки для nginx `secure_link`. docs/architecture.md §9.4
 *
 * Аватаров и превью на одной странице бывают сотни, и проверять права на
 * каждый запрос — это сотни вызовов auth-service ради картинок, которые
 * и так видны всем, кто видит сотрудника. Поэтому здесь выдаётся ссылка
 * с подписью и сроком, а проверяет её сам nginx: приложение при отдаче не
 * вызывается вообще.
 *
 * ФОРМАТ ПОДПИСИ ЗАДАН NGINX, а не выбран здесь:
 *
 *     secure_link_md5 "$secure_link_expires$uri$remote_addr SECRET";
 *
 * то есть md5 от склейки срока, пути, адреса клиента, пробела и секрета,
 * в кодировке base64url без выравнивающих символов. Любое расхождение —
 * другой порядок, лишний разделитель, base64 вместо base64url — даёт
 * молчаливый 403 на все ссылки разом. Здесь склейка воспроизведена
 * буквально и снабжена этим комментарием именно поэтому.
 *
 * MD5 в подписи — требование nginx, а не выбор криптостойкости. Секрет в
 * склейку входит, поэтому подобрать подпись без него нельзя; коллизии
 * MD5 здесь ничего не дают, так как злоумышленник не управляет
 * содержимым хэшируемой строки.
 */
@Injectable()
export class SignedLinkService {
  constructor(@Inject(FILE_CONFIG) private readonly config: FileConfig) {}

  /**
   * Адрес клиента входит в подпись, поэтому ссылку нельзя переслать
   * другому человеку: у него другой $remote_addr, и nginx ответит 403.
   * Обратная сторона — смена сети рвёт уже выданные ссылки, но при сроке
   * жизни в сутки это дешевле, чем ссылка на документ, гуляющая по
   * переписке.
   */
  issue(input: {
    relativePath: string;
    clientIp: string;
    ttlSeconds?: number;
    thumbnail?: boolean;
  }): { url: string; expiresAt: number } {
    const ttl = clamp(input.ttlSeconds ?? this.config.signedLinkTtlSeconds);
    const expires = Math.floor(Date.now() / 1000) + ttl;

    const uri = `/files/${input.relativePath}`;
    const signature = createHash('md5')
      .update(`${expires}${uri}${input.clientIp} ${this.config.signedLinkSecret}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return {
      url: `${uri}?sig=${signature}&expires=${expires}`,
      expiresAt: expires * 1000,
    };
  }
}

/** От минуты до недели: срок задаёт вызывающий, но не произвольный. */
function clamp(ttlSeconds: number): number {
  return Math.min(Math.max(Math.floor(ttlSeconds), 60), 604_800);
}
