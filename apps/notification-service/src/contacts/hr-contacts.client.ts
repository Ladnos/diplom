import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface HrContact {
  employeeId: string;
  userId: string;
  email: string;
  fullName: string;
  active: boolean;
}

interface StaffGrpc {
  GetContacts(data: { ids: string[] }): Observable<{
    contacts: {
      employee_id: string;
      email: string;
      phone: string;
      user_id: string;
      full_name: string;
      active: boolean;
    }[];
  }>;
}

/**
 * Единственный исходящий gRPC-вызов сервиса — и только как fallback (§6.3).
 *
 * Штатный источник контактов — события hr.employee.* (§7.5). Сюда попадают
 * только те, кого в локальной проекции нет: сервис развернули позже
 * остальных, событие ушло в DLQ, базу пересоздали. Отказ вызова — не
 * ошибка обработки: уведомление уйдёт тем, кого мы знаем, а не сорвётся
 * целиком из-за недоступного hr-service.
 */
@Injectable()
export class HrContactsClient implements OnModuleInit {
  private readonly logger = new Logger(HrContactsClient.name);
  private staff!: StaffGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.HR)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.staff = this.client.getService<StaffGrpc>('StaffService');
  }

  async fetch(employeeIds: string[]): Promise<HrContact[]> {
    if (employeeIds.length === 0) return [];

    try {
      const result = await firstValueFrom(
        this.staff.GetContacts({ ids: employeeIds }).pipe(timeout(DEADLINES_MS.DEFAULT)),
      );
      return (result.contacts ?? [])
        // Сотрудник без учётной записи адресатом быть не может: вся
        // персональная часть уведомлений ключуется по userId.
        .filter((contact) => contact.user_id && contact.email)
        .map((contact) => ({
          employeeId: contact.employee_id,
          userId: contact.user_id,
          email: contact.email,
          fullName: contact.full_name,
          active: contact.active,
        }));
    } catch (error) {
      this.logger.warn({
        message: 'не удалось получить контакты из hr-service, работаем по локальной проекции',
        employeeIds: employeeIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
