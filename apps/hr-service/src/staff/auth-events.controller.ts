import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { AuthEvents, type Envelope, type UserRegistered } from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { StaffService } from './staff.service';

const CONSUMER = 'hr-service';

/** Регистрация несёт ФИО, которого нет в модели auth-service. */
type RegistrationPayload = UserRegistered & { fullName?: string };

/**
 * Потребители событий hr-service (очередь hr.events, §7.5).
 *
 * Создание профиля сотрудника — асинхронная реакция на регистрацию, а не
 * часть транзакции auth-service: сервисы владеют разными базами, и
 * распределённой транзакции между ними нет по построению. Пользователь
 * получает ответ сразу после создания учётной записи, профиль появляется
 * следом (§10.1).
 */
@Controller()
export class AuthEventsController {
  private readonly logger = new Logger(AuthEventsController.name);

  constructor(
    private readonly staff: StaffService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  @EventPattern(AuthEvents.USER_REGISTERED)
  async onUserRegistered(
    @Payload() envelope: Envelope<RegistrationPayload>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        const employee = await this.staff.createFromRegistration({
          userId: payload.userId,
          email: payload.email,
          fullName: payload.fullName ?? payload.email,
        });

        if (employee) {
          this.logger.log({
            message: 'профиль создан по регистрации',
            userId: payload.userId,
            employeeId: employee.id,
          });
        }
      },
    );
  }
}
