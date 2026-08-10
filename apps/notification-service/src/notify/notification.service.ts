import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  Envelope,
  EventType,
  NotificationAudience,
  NotificationChannel,
  NotificationSend,
} from '@crm/contracts';
import { Channel, Prisma, Priority, type Contact } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { ContactsService } from '../contacts/contacts.service';
import { PresenceService } from '../contacts/presence.service';
import { PreferencesService, allows, type ResolvedPreferences } from './preferences.service';
import { scheduleAfterQuietHours } from './quiet-hours';
import { PROJECTIONS } from './projections.catalog';
import { RULES, type Addressed, type NotificationDraft, type RuleFn } from './rules.catalog';

const CONSUMER = 'notification-service';

interface PlannedRows {
  notifications: Prisma.NotificationCreateManyInput[];
  deliveries: Prisma.DeliveryCreateManyInput[];
}

/**
 * Маршрутизация уведомлений: событие → получатели → строки в базе.
 *
 * Отправкой этот класс не занимается. Обработчик события обязан ответить
 * брокеру за миллисекунды, а SMTP отвечает секундами и падает; если бы
 * письмо уходило прямо здесь, недоступный почтовый сервер приводил бы к
 * nack, повторной доставке всего события и дублю уже отправленного по
 * другим каналам. Поэтому здесь — только решение и запись, а отправка
 * живёт в DeliveryWorker.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly presence: PresenceService,
    private readonly preferences: PreferencesService,
  ) {}

  /**
   * Обработка доменного события.
   *
   * Порядок обязателен: сначала проекция контактов, потом правило.
   * hr.employee.created создаёт контакт, по которому в этом же событии
   * может понадобиться кого-то уведомить.
   */
  async handleEvent(envelope: Envelope): Promise<void> {
    const eventType = envelope.eventType;
    const projection = PROJECTIONS[eventType];
    const rule = RULES[eventType] as RuleFn<unknown> | undefined;

    // Ни правила, ни проекции — событие проходит мимо. Отметку об
    // обработке не ставим: сервис подписан на весь поток системы, и
    // журнал «видел, но ничего не сделал» был бы копией всей шины.
    if (!projection && !rule) return;

    if (await this.isDuplicate(envelope.eventId)) {
      this.logger.debug({ message: 'дубликат события отброшен', eventId: envelope.eventId });
      return;
    }

    if (projection) {
      await (projection as (payload: unknown, contacts: ContactsService) => Promise<void>)(
        envelope.payload,
        this.contacts,
      );
    }

    const addressed = rule
      ? await rule(envelope.payload, { contacts: this.contacts, presence: this.presence })
      : [];

    await this.persist(envelope.eventId, eventType, addressed);
  }

  /**
   * Обработка команды notification.send / notification.broadcast (§7.4).
   *
   * Отличие от события — в источнике текста: команду отправляет сервис,
   * который в этот момент знает подробности, которых нет ни в одном
   * доменном событии.
   */
  async handleCommand(envelope: Envelope<NotificationSend>): Promise<number> {
    const payload = envelope.payload;
    const recipients = await this.resolveAudience(payload.audience);

    if (recipients.length === 0) {
      this.logger.warn({
        message: 'команда уведомления не нашла ни одного получателя',
        eventId: envelope.eventId,
        eventType: envelope.eventType,
      });
      // Отметку всё равно ставим: повторная доставка той же команды
      // получателей не найдёт тем более, а DLQ забивать нечем.
      await this.persist(envelope.eventId, envelope.eventType, []);
      return 0;
    }

    const draft: NotificationDraft = {
      title: payload.title,
      body: payload.body,
      link: payload.link,
      priority: payload.priority,
      channels: payload.channels ?? ['IN_APP', 'EMAIL'],
    };

    return this.persist(
      envelope.eventId,
      (payload.eventType ?? envelope.eventType) as EventType,
      [{ userIds: recipients.map((contact) => contact.userId), draft }],
    );
  }

  /** Разрешение аудитории команды. Способы адресации складываются. */
  private async resolveAudience(audience: NotificationAudience): Promise<Contact[]> {
    if (audience.everyone) return this.contacts.everyone();

    const groups = await Promise.all([
      this.contacts.byUserIds(audience.userIds ?? []),
      this.contacts.byEmployeeIds(audience.employeeIds ?? []),
      this.contacts.byDepartments(audience.departmentIds ?? []),
      this.contacts.byRoles(audience.roleCodes ?? []),
    ]);

    const byUser = new Map<string, Contact>();
    for (const contact of groups.flat()) byUser.set(contact.userId, contact);
    return [...byUser.values()];
  }

  /**
   * Запись решения и отметки об обработке ОДНОЙ транзакцией.
   *
   * Именно это делает потребителя идемпотентным (§7.7): повторная
   * доставка события упирается в уникальный ключ processed_events и
   * откатывает вставку уведомлений целиком. Разнести их — значит
   * получить окно, в котором уведомления записаны, а отметка нет, и
   * повтор рассылает всё второй раз.
   */
  private async persist(
    eventId: string,
    eventType: string,
    addressed: Addressed[],
  ): Promise<number> {
    const rows = await this.plan(eventId, eventType, addressed);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({ data: { eventId, consumer: CONSUMER, eventType } });
        if (rows.notifications.length > 0) {
          await tx.notification.createMany({ data: rows.notifications });
        }
        if (rows.deliveries.length > 0) {
          await tx.delivery.createMany({ data: rows.deliveries });
        }
      });
    } catch (error) {
      // Гонка двух консьюмеров на одном сообщении: второй проиграл вставку
      // отметки. Это штатный исход дедупликации, а не сбой обработки.
      if (isUniqueViolation(error)) {
        this.logger.debug({ message: 'событие уже обработано параллельно', eventId });
        return 0;
      }
      throw error;
    }

    if (rows.notifications.length > 0) {
      this.logger.log({
        message: 'уведомления поставлены в очередь',
        eventType,
        eventId,
        notifications: rows.notifications.length,
        deliveries: rows.deliveries.length,
      });
    }
    return rows.notifications.length;
  }

  /**
   * Раскрытие черновиков в строки таблиц.
   *
   * Все чтения — пачками: рассылка на отдел из пятидесяти человек не
   * должна превращаться в полторы сотни запросов.
   */
  private async plan(
    sourceEventId: string,
    eventType: string,
    addressed: Addressed[],
  ): Promise<PlannedRows> {
    const rows: PlannedRows = { notifications: [], deliveries: [] };
    const userIds = [...new Set(addressed.flatMap((item) => item.userIds))];
    if (userIds.length === 0) return rows;

    const [contacts, preferences, subscriptions] = await Promise.all([
      this.prisma.contact.findMany({ where: { userId: { in: userIds } } }),
      this.preferences.resolveMany(userIds),
      this.prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } }),
    ]);

    const contactByUser = new Map(contacts.map((contact) => [contact.userId, contact]));
    const subsByUser = new Map<string, string[]>();
    for (const subscription of subscriptions) {
      const list = subsByUser.get(subscription.userId) ?? [];
      list.push(subscription.endpoint);
      subsByUser.set(subscription.userId, list);
    }

    const now = new Date();

    for (const item of addressed) {
      const channels = new Set<NotificationChannel>(item.draft.channels ?? ['IN_APP']);
      const priority = (item.draft.priority ?? 'NORMAL') as Priority;

      for (const userId of new Set(item.userIds)) {
        const contact = contactByUser.get(userId);
        const settings = preferences.get(userId);
        if (!contact || !settings) continue;

        const notificationId = randomUUID();
        const deliveries = this.planDeliveries({
          notificationId,
          eventType,
          channels,
          priority,
          contact,
          settings,
          endpoints: subsByUser.get(userId) ?? [],
          now,
        });

        const visible =
          channels.has('IN_APP') && allows(settings, Channel.IN_APP, eventType);

        // Ни показать, ни отправить — записывать нечего. Иначе каждое
        // сообщение чата отложилось бы строкой, которую никто никогда
        // не увидит.
        if (!visible && deliveries.length === 0) continue;

        rows.notifications.push({
          id: notificationId,
          userId,
          eventType,
          sourceEventId,
          priority,
          title: item.draft.title,
          body: item.draft.body,
          link: item.draft.link ?? null,
          visible,
        });
        rows.deliveries.push(...deliveries);
      }
    }

    return rows;
  }

  private planDeliveries(input: {
    notificationId: string;
    eventType: string;
    channels: Set<NotificationChannel>;
    priority: Priority;
    contact: Contact;
    settings: ResolvedPreferences;
    endpoints: string[];
    now: Date;
  }): Prisma.DeliveryCreateManyInput[] {
    const deliveries: Prisma.DeliveryCreateManyInput[] = [];

    // Тихие часы сдвигают отправку, но не отменяют её. URGENT проходит
    // насквозь: приглашение в звонок, доставленное утром, бесполезно.
    const scheduledFor =
      input.priority === Priority.URGENT
        ? input.now
        : scheduleAfterQuietHours(input.settings.quietHours, input.now);

    if (
      input.channels.has('EMAIL') &&
      input.contact.email !== '' &&
      allows(input.settings, Channel.EMAIL, input.eventType)
    ) {
      deliveries.push({
        notificationId: input.notificationId,
        channel: Channel.EMAIL,
        target: input.contact.email,
        scheduledFor,
      });
    }

    if (
      input.channels.has('WEB_PUSH') &&
      allows(input.settings, Channel.WEB_PUSH, input.eventType)
    ) {
      // По строке на устройство: у человека столько подписок, сколько
      // браузеров, и протухание одной не должно отменять остальные.
      for (const endpoint of input.endpoints) {
        deliveries.push({
          notificationId: input.notificationId,
          channel: Channel.WEB_PUSH,
          target: endpoint,
          scheduledFor,
        });
      }
    }

    return deliveries;
  }

  private async isDuplicate(eventId: string): Promise<boolean> {
    const found = await this.prisma.processedEvent.findUnique({
      where: { eventId_consumer: { eventId, consumer: CONSUMER } },
      select: { eventId: true },
    });
    return found !== null;
  }
}

/** P2002 — нарушение уникального ключа. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
