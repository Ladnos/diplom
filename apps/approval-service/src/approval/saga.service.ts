import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApprovalEvents, type RequestEscalated } from '@crm/contracts';
import { getRequestContext, numberEnv } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { HrClient } from '../clients/hr.client';

/**
 * Фоновые проверки процесса согласования.
 *
 * Два независимых сторожа, каждый закрывает свой способ «зависнуть»:
 *
 *  1. САГА. Заявка перешла в APPROVED, событие ушло, но подтверждение от
 *     владельца данных не пришло — сервис лежал, сообщение попало в DLQ,
 *     применение упало без обработчика. Без таймера заявка осталась бы
 *     в APPROVED навсегда: сотрудник считает отпуск согласованным, а
 *     в кадровом сервисе его нет. Худший из возможных исходов —
 *     расхождение, о котором никто не знает.
 *
 *  2. SLA. Руководитель не рассмотрел заявку в срок. Она поднимается
 *     на уровень выше, а не ждёт бесконечно.
 */
@Injectable()
export class SagaService {
  private readonly logger = new Logger(SagaService.name);

  /** Сколько ждать подтверждения применения (§7.7: 5 минут). */
  private readonly applyTimeoutMs = numberEnv('APPROVAL_APPLY_TIMEOUT_MS', 5 * 60 * 1000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hr: HrClient,
    private readonly publisher: EventPublisher,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async checkStuckSagas(): Promise<void> {
    const threshold = new Date(Date.now() - this.applyTimeoutMs);

    const stuck = await this.prisma.request.findMany({
      where: { status: 'APPROVED', approvedAt: { lt: threshold } },
      select: { id: true, type: true, authorEmployeeId: true, approvedAt: true },
      take: 100,
    });
    if (stuck.length === 0) return;

    for (const request of stuck) {
      await this.prisma.request.updateMany({
        where: { id: request.id, status: 'APPROVED' },
        data: {
          status: 'APPLY_FAILED',
          failureReason:
            'решение принято, но сервис-исполнитель не подтвердил применение за отведённое время. ' +
            'Проверьте очередь и повторите операцию',
        },
      });

      this.logger.error({
        message: 'сага согласования зависла: подтверждение применения не получено',
        requestId: request.id,
        type: request.type,
        approvedAt: request.approvedAt?.toISOString(),
      });
    }

    this.logger.warn({ message: 'зависшие заявки переведены в APPLY_FAILED', count: stuck.length });
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkSlaBreaches(): Promise<void> {
    const overdue = await this.prisma.request.findMany({
      where: { status: 'PENDING', slaDeadline: { lt: new Date() } },
      include: { steps: { orderBy: { order: 'asc' } } },
      take: 100,
    });
    if (overdue.length === 0) return;

    for (const request of overdue) {
      const step = request.steps.find((item) => item.order === request.currentStep);
      if (!step) continue;

      // Эскалация — руководителю текущего согласующего. Если его нет,
      // поднимать некуда: заявка помечается просроченной, и это видно
      // и автору, и в отчётности.
      const chain = await this.hr
        .getManagerChain(step.approverEmployeeId)
        .catch(() => ({ employees: [] }));
      const nextApprover = chain.employees[0]?.employee_id;

      if (!nextApprover || nextApprover === request.authorEmployeeId) {
        await this.prisma.request.update({
          where: { id: request.id },
          data: {
            status: 'EXPIRED',
            slaDeadline: null,
            failureReason: 'истёк срок рассмотрения, эскалировать некому',
          },
        });
        this.logger.warn({ message: 'заявка просрочена без эскалации', requestId: request.id });
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.approvalStep.update({
          where: { id: step.id },
          data: {
            status: 'SKIPPED',
            comment: 'эскалировано: истёк срок рассмотрения',
            decidedAt: new Date(),
          },
        });
        await tx.approvalStep.create({
          data: {
            requestId: request.id,
            order: step.order + 1,
            approverEmployeeId: nextApprover,
          },
        });
        await tx.request.update({
          where: { id: request.id },
          data: {
            currentStep: step.order + 1,
            slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });

        const envelope = this.publisher.wrap<RequestEscalated>(
          ApprovalEvents.REQUEST_ESCALATED,
          {
            requestId: request.id,
            fromApproverEmployeeId: step.approverEmployeeId,
            toApproverEmployeeId: nextApprover,
          },
          getRequestContext(),
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      });

      this.logger.warn({
        message: 'заявка эскалирована по истечении срока',
        requestId: request.id,
        from: step.approverEmployeeId,
        to: nextApprover,
      });
    }
  }
}
