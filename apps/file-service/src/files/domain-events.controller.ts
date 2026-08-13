import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  ChatEvents,
  Commands,
  TaskEvents,
  VideoEvents,
  type CardDeleted,
  type Envelope,
  type MessageDeleted,
  type RecordingReady,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { EntityType } from '../../generated/prisma';
import { FileService } from './file.service';
import { MaintenanceService } from './maintenance.service';

const CONSUMER = 'file-service';

/**
 * Потребители очереди file.events (§7.5).
 *
 * Все привязки очереди — и события, и команды — имеют здесь обработчик.
 * NestJS отвечает `nack(requeue: false)` на сообщение, для которого не
 * нашлось `@EventPattern`, и оно уходит в DLQ; привязка без обработчика
 * не «игнорируется», а копит мёртвые сообщения. К моменту реализации
 * этого сервиса в `file.events.dlq` уже лежали события об удалённых
 * сообщениях чата — ровно по этой причине.
 */
@Controller()
export class DomainEventsController {
  private readonly logger = new Logger(DomainEventsController.name);

  constructor(
    private readonly files: FileService,
    private readonly maintenance: MaintenanceService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  /**
   * Удалена карточка — её вложения больше ею не удерживаются.
   *
   * Файлы при этом не удаляются: то же содержимое может висеть в чате
   * или в другой карточке. Уменьшается счётчик ссылок, а решение об
   * удалении принимает сборщик мусора, когда убедится, что не ссылается
   * никто (§9.5).
   */
  @EventPattern(TaskEvents.CARD_DELETED)
  async onCardDeleted(@Payload() envelope: Envelope<CardDeleted>, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.files.detachEntity(EntityType.TASK_CARD, payload.cardId);
      },
    );
  }

  @EventPattern(ChatEvents.MESSAGE_DELETED)
  async onMessageDeleted(
    @Payload() envelope: Envelope<MessageDeleted>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.files.detachEntity(EntityType.CHAT_MESSAGE, payload.messageId);
      },
    );
  }

  /**
   * Готова запись звонка.
   *
   * Появится вместе с video-service: SFU кладёт поток в tmp/recordings, а
   * принять его в хранилище должен этот сервис. Обработчик объявлен
   * заранее, потому что привязка `video.recording.ready` в очереди уже
   * существует — без него первое же событие ушло бы в DLQ.
   */
  @EventPattern(VideoEvents.RECORDING_READY)
  async onRecordingReady(
    @Payload() envelope: Envelope<RecordingReady>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        this.logger.log({
          message: 'запись звонка ожидает приёма в хранилище',
          roomId: payload.roomId,
          rawPath: payload.rawPath,
        });
      },
    );
  }

  /**
   * Команда обработки медиа: превью и транскодирование через ffmpeg.
   *
   * ffmpeg в образе нет, и добавлять его ради ветки, которую сегодня
   * никто не вызывает, — это две сотни мегабайт в каждом слое сборки.
   * Обработчик подтверждает команду и оставляет запись в журнале:
   * молчаливое накопление в DLQ было бы хуже честного «пока не умею».
   */
  @EventPattern(Commands.MEDIA_PROCESS)
  async onMediaProcess(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        this.logger.warn({
          message: 'обработка медиа не реализована: нужен ffmpeg в образе',
          eventId: envelope.eventId,
        });
      },
    );
  }

  /** Внеочередная сборка мусора по команде извне. */
  @EventPattern(Commands.FILE_GC_RUN)
  async onGcRun(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        const report = await this.maintenance.collect();
        this.logger.log({ message: 'сборка мусора по команде', ...report });
      },
    );
  }
}
