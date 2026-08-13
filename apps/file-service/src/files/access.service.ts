import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';
import { EntityType, type FileMeta } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { AuthClient } from '../auth/auth.client';
import type { FileActor } from '../auth/token.guard';

/** Сколько привязок проверяем, прежде чем сдаться. */
const MAX_ATTACHMENT_PROBES = 5;

interface ChatGrpc {
  CanAccessMessage(data: {
    message_id: string;
    employee_id: string;
  }): Observable<{ value: boolean; reason: string }>;
}

interface TaskGrpc {
  GetCard(data: { card_id: string; actor_employee_id: string }): Observable<{ card_id: string }>;
}

/**
 * Кому отдавать файл. docs/architecture.md §9.3
 *
 * Владение файлом само по себе не отвечает на вопрос доступа. Вложение к
 * сообщению в чате принадлежит тому, кто его загрузил, а видеть его
 * должны все участники канала — и перестать видеть, когда их из канала
 * исключат. Значит, право на файл — это право на сущность, в которой он
 * висит, и решает его тот сервис, который этой сущностью владеет.
 *
 * Порядок проверок идёт от дешёвых к дорогим: собственный файл и
 * административные права разрешаются локально и по одному вызову
 * auth-service, и только потом начинается обход привязок с походами в
 * чужие сервисы.
 *
 * Обратной зависимости нет: chat-service и task-service файловый сервис
 * не вызывают — они лишь публикуют события об удалении своих сущностей.
 */
@Injectable()
export class AccessService implements OnModuleInit {
  private readonly logger = new Logger(AccessService.name);
  private chat!: ChatGrpc;
  private tasks!: TaskGrpc;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthClient,
    @Inject(grpcClientToken(SERVICES.CHAT)) private readonly chatClient: ClientGrpc,
    @Inject(grpcClientToken(SERVICES.TASK)) private readonly taskClient: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.chat = this.chatClient.getService<ChatGrpc>('ChatService');
    this.tasks = this.taskClient.getService<TaskGrpc>('TaskService');
  }

  async mayRead(meta: FileMeta, actor: FileActor): Promise<boolean> {
    if (actor.employeeId && meta.ownerEmployeeId === actor.employeeId) return true;

    // Указываем владельца явно: без него auth-service отвечает «право
    // есть, область не проверялась» и пустил бы к чужому файлу любого,
    // у кого вообще есть право читать файлы.
    const decision = await this.auth
      .checkPermission({
        userId: actor.userId,
        resource: 'file',
        action: 'read',
        resourceId: meta.id,
        ownerId: meta.ownerEmployeeId,
      })
      .catch(() => ({ allowed: false, reason: 'auth недоступен', scope: '' }));
    if (decision.allowed) return true;

    if (!actor.employeeId) return false;
    return this.reachableThroughAttachments(meta.id, actor);
  }

  /**
   * Доступ через сущность, к которой файл прикреплён.
   *
   * Достаточно одной привязки, дающей доступ: файл, разосланный в два
   * канала, виден участнику любого из них. Обход ограничен сверху — файл
   * с сотней привязок не должен превращать одно скачивание в сотню
   * межсервисных вызовов.
   */
  private async reachableThroughAttachments(
    fileId: string,
    actor: FileActor,
  ): Promise<boolean> {
    const attachments = await this.prisma.attachment.findMany({
      where: { fileId },
      orderBy: { createdAt: 'asc' },
      take: MAX_ATTACHMENT_PROBES,
    });

    for (const attachment of attachments) {
      if (await this.mayAccessEntity(attachment.entityType, attachment.entityId, actor)) {
        return true;
      }
    }
    return false;
  }

  private async mayAccessEntity(
    entityType: EntityType,
    entityId: string,
    actor: FileActor,
  ): Promise<boolean> {
    const employeeId = actor.employeeId ?? '';

    try {
      switch (entityType) {
        case EntityType.CHAT_MESSAGE: {
          const result = await firstValueFrom(
            this.chat
              .CanAccessMessage({ message_id: entityId, employee_id: employeeId })
              .pipe(timeout(DEADLINES_MS.PERMISSION)),
          );
          return result.value;
        }

        case EntityType.TASK_CARD: {
          // GetCard сам проверяет участие в доске и отвечает
          // PERMISSION_DENIED — отдельный метод-проверка не нужен.
          await firstValueFrom(
            this.tasks
              .GetCard({ card_id: entityId, actor_employee_id: employeeId })
              .pipe(timeout(DEADLINES_MS.PERMISSION)),
          );
          return true;
        }

        case EntityType.EMPLOYEE_AVATAR: {
          // Аватар видит всякий, кто видит самого сотрудника. Владелец
          // здесь — кадровый сервис, но спрашивать его незачем: вопрос
          // сводится к обычной области действия, которую знает auth.
          // entityId — идентификатор сотрудника, а не отдельной сущности.
          const decision = await this.auth.checkPermission({
            userId: actor.userId,
            resource: 'employee',
            action: 'read',
            ownerId: entityId,
          });
          return decision.allowed;
        }

        default:
          // CALL_RECORDING и TIMESHEET_EXPORT появятся вместе со своими
          // сервисами. До тех пор — отказ: неизвестный тип привязки не
          // повод открывать доступ.
          return false;
      }
    } catch (error) {
      // Отказ сервиса-владельца и его недоступность одинаково означают
      // «не подтверждено». Открывать доступ при недоступности нельзя.
      this.logger.debug({
        message: 'сущность не подтвердила доступ',
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
