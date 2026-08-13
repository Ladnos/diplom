/**
 * Перевод кодов домена на человеческий язык.
 *
 * Собрано в одном файле, потому что одни и те же коды встречаются на
 * пяти экранах: тип заявки виден и в списке, и в карточке, и в отчёте.
 * Разложенные по компонентам подписи разъезжаются на второй неделе —
 * где-то «Отпуск», где-то «Ежегодный отпуск».
 */

export const REQUEST_TYPES: Record<string, string> = {
  VACATION: 'Отпуск',
  TIME_OFF: 'Отгул',
  OVERTIME: 'Переработка',
  SHIFT_SWAP: 'Обмен сменами',
  TIMESHEET_FIX: 'Корректировка табеля',
  TRIP: 'Командировка',
  PERIOD_CLOSE: 'Закрытие периода',
  WORK_ACT: 'Акт выполненных работ',
};

export const REQUEST_STATUSES: Record<string, { label: string; variant: string }> = {
  DRAFT: { label: 'Черновик', variant: 'muted' },
  PENDING: { label: 'На рассмотрении', variant: 'warning' },
  APPROVED: { label: 'Согласовано', variant: 'success' },
  REJECTED: { label: 'Отклонено', variant: 'destructive' },
  CANCELLED: { label: 'Отозвано', variant: 'muted' },
  // APPLIED — результат применён владельцем данных: отпуск занесён в
  // график, переработка попала в табель. Это конец саги, а не отдельное
  // решение, поэтому подпись отличается от «Согласовано» (§10.3).
  APPLIED: { label: 'Применено', variant: 'success' },
  FAILED: { label: 'Ошибка применения', variant: 'destructive' },
};

export const ABSENCE_TYPES: Record<string, string> = {
  VACATION: 'Отпуск',
  SICK_LEAVE: 'Больничный',
  TIME_OFF: 'Отгул',
  BUSINESS_TRIP: 'Командировка',
  UNPAID: 'За свой счёт',
};

export const EMPLOYMENT_TYPES: Record<string, string> = {
  LABOR_CONTRACT: 'Трудовой договор',
  CIVIL_CONTRACT: 'Договор ГПХ',
  SELF_EMPLOYED: 'Самозанятый',
  ENTREPRENEUR: 'ИП',
  OUTSTAFF: 'Аутстафф',
  INTERN: 'Стажёр',
};

export const PAYMENT_FORMS: Record<string, string> = {
  SALARY: 'Оклад',
  HOURLY: 'Почасовая',
  PIECEWORK: 'Сдельная',
  PER_ACT: 'По актам',
};

/**
 * Политика учёта времени — производная величина, от которой ветвится
 * почти всё (§3.2). Подпись объясняет, что именно считается.
 */
export const TIME_POLICIES: Record<string, { label: string; hint: string }> = {
  NORM_BASED: { label: 'По норме', hint: 'Табель считается от графика: норма − отсутствия + переработки' },
  FACT_BASED: { label: 'По факту', hint: 'Требует фактического учёта прихода и ухода' },
  DELIVERABLE_BASED: { label: 'По результату', hint: 'Учитываются закрытые задачи, а не часы' },
  NONE: { label: 'Не ведётся', hint: 'Рабочее время не учитывается' },
};

export const CHANNEL_TYPES: Record<string, string> = {
  PUBLIC: 'Открытый',
  PRIVATE: 'Закрытый',
  DIRECT: 'Личная переписка',
  GROUP: 'Групповой',
  ANNOUNCEMENT: 'Объявления',
};

export const ROLE_TITLES: Record<string, string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Руководитель',
  HR: 'Кадровая служба',
  EMPLOYEE: 'Сотрудник',
  ACCOUNTANT: 'Бухгалтерия',
};

/** Подпись типа события для журнала аудита: `approval.request.approved`. */
export function eventTitle(eventType: string): string {
  const [context, aggregate, action] = eventType.split('.');
  const contexts: Record<string, string> = {
    auth: 'Доступ',
    hr: 'Кадры',
    approval: 'Согласование',
    task: 'Задачи',
    chat: 'Переписка',
    video: 'Звонки',
    file: 'Файлы',
    notification: 'Уведомления',
    analytics: 'Отчёты',
  };
  return `${contexts[context] ?? context} · ${aggregate ?? ''} ${action ?? ''}`.trim();
}

export function requestTitle(type: string): string {
  return REQUEST_TYPES[type] ?? type;
}

export function statusOf(status: string): { label: string; variant: string } {
  return REQUEST_STATUSES[status] ?? { label: status, variant: 'muted' };
}
