import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  HrEvents,
  VideoEvents,
  type CallEnded,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type Envelope,
  type HierarchyChanged,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { MessageService } from './message.service';

const CONSUMER = 'chat-service';

/**
 * Потребители очереди chat.events (§7.5).
 *
 * ОДИН ОБРАБОТЧИК НА ПАТТЕРН ПРИВЯЗКИ, а не по обработчику на событие.
 * NestJS ищет обработчик по routing key и, не найдя, отвечает
 * nack(requeue: false) — сообщение уходит в DLQ. Перечисление событий
 * поимённо работает ровно до появления нового `hr.employee.*`, после чего
 * оно молча копится в очереди мёртвых сообщений. Маска обработчика
 * повторяет маску привязки, а разбор по типам идёт внутри.
 */
@Controller()
export class DomainEventsController {
  private readonly logger = new Logger(DomainEventsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessageService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  /**
   * Кадровая проекция (§6.3).
   *
   * Чату нужны имя для системных сообщений, признак увольнения и
   * руководитель — по нему определяется право писать в канал объявлений.
   * Ходить за этим в hr-service на каждое сообщение нельзя: переписка
   * обязана работать и при недоступном кадровом сервисе.
   */
  @EventPattern('hr.employee.#')
  async onEmployeeEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        switch (envelope.eventType) {
          case HrEvents.EMPLOYEE_CREATED:
            return this.employeeCreated(envelope.payload as EmployeeCreated);
          case HrEvents.EMPLOYEE_UPDATED:
            return this.employeeUpdated(envelope.payload as EmployeeUpdated);
          case HrEvents.EMPLOYEE_DEACTIVATED:
            return this.employeeDeactivated(envelope.payload as EmployeeDeactivated);
          default:
            // Событие из того же контекста, но чату безразличное.
            // Подтверждаем и проходим мимо.
            return;
        }
      },
    );
  }

  /**
   * Перевод под другого руководителя.
   *
   * Без этого события проекция отставала бы молча: hr.employee.# приносит
   * начальника только при создании и правке карточки, а перевод внутри
   * оргструктуры идёт отдельным событием. Отставание проявилось бы не
   * ошибкой, а тем, что новый руководитель не может написать в канал
   * объявлений своего отдела.
   */
  @EventPattern(HrEvents.HIERARCHY_CHANGED)
  async onHierarchyChanged(
    @Payload() envelope: Envelope<HierarchyChanged>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.prisma.employeeRef.updateMany({
          where: { employeeId: payload.employeeId },
          data: { managerEmployeeId: payload.newManagerId ?? null },
        });
      },
    );
  }

  /**
   * Завершение звонка — системной записью в канал, из которого он начат.
   *
   * Именно сообщением, а не уведомлением: разговор состоялся внутри
   * переписки и должен остаться в её истории. Иначе через неделю по
   * каналу невозможно понять, что решение принимали голосом (§8.3).
   */
  @EventPattern(VideoEvents.CALL_ENDED)
  async onCallEnded(@Payload() envelope: Envelope<CallEnded>, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        if (!payload.channelId) return;

        await this.messages.postSystemMessage({
          channelId: payload.channelId,
          body: `Звонок завершён, ${formatDuration(payload.durationSec)}${
            payload.recorded ? '. Запись сохранена' : ''
          }`,
          // Ключ идемпотентности на уровне БД: повторная доставка события
          // упрётся в уникальный индекс, даже если отметка об обработке
          // не успела записаться.
          clientMessageId: `call-ended:${payload.roomId}`,
        });
      },
    );
  }

  private async employeeCreated(payload: EmployeeCreated): Promise<void> {
    await this.prisma.employeeRef.upsert({
      where: { employeeId: payload.employeeId },
      create: {
        employeeId: payload.employeeId,
        fullName: payload.fullName,
        departmentId: payload.departmentId ?? null,
        managerEmployeeId: payload.managerId ?? null,
        active: true,
      },
      update: {
        fullName: payload.fullName,
        departmentId: payload.departmentId ?? null,
        managerEmployeeId: payload.managerId ?? null,
        active: true,
      },
    });
  }

  private async employeeUpdated(payload: EmployeeUpdated): Promise<void> {
    const changed = payload.changed ?? {};
    // Пустое обновление — не ошибка: событие могло нести только те поля,
    // которые чату безразличны (должность, аватар).
    const data = {
      ...(changed.fullName !== undefined ? { fullName: changed.fullName } : {}),
      ...(changed.departmentId !== undefined ? { departmentId: changed.departmentId } : {}),
      ...(changed.managerId !== undefined ? { managerEmployeeId: changed.managerId } : {}),
    };
    if (Object.keys(data).length === 0) return;

    await this.prisma.employeeRef.updateMany({
      where: { employeeId: payload.employeeId },
      data,
    });
  }

  /**
   * Увольнение.
   *
   * Из каналов человек выводится, но сообщения остаются: переписка — это
   * история решений, и вычищать из неё автора значило бы делать историю
   * нечитаемой. Личные переписки тоже сохраняются — собеседник должен
   * видеть, о чём договаривались.
   */
  private async employeeDeactivated(payload: EmployeeDeactivated): Promise<void> {
    await this.prisma.employeeRef.upsert({
      where: { employeeId: payload.employeeId },
      create: { employeeId: payload.employeeId, fullName: '', active: false },
      update: { active: false },
    });

    const removed = await this.prisma.channelMember.deleteMany({
      where: {
        employeeId: payload.employeeId,
        channel: { type: { not: 'DIRECT' } },
      },
    });

    this.logger.log({
      message: 'сотрудник уволен: выведен из каналов',
      employeeId: payload.employeeId,
      channels: removed.count,
    });
  }
}

/** «42 мин», «1 ч 05 мин» — без секунд: точность здесь никому не нужна. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  if (total < 60) return `${total} мин`;

  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
}
