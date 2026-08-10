import type {
  AbsenceType,
  DatePeriod,
  EmploymentType,
  RequestType,
} from '@crm/contracts';

/**
 * Шаблоны и форматирование текста уведомлений.
 *
 * Шаблоны лежат в коде, а не в таблице базы. Причина та же, по которой в
 * коде лежит матрица прав (rbac.seed.ts): текст уведомления — часть
 * поведения системы, он меняется вместе с payload события, которое в него
 * подставляется. Хранение в БД дало бы редактирование без пересборки и
 * ровно одну новую проблему: шаблон, ссылающийся на поле, которого в
 * событии больше нет, ломается в рантайме у случайного пользователя.
 *
 * Сам текст собирается в каталоге правил (rules.catalog.ts) — здесь
 * общие словари и функции форматирования, чтобы «3 ч 30 мин» и
 * «15 сентября 2026 г.» выглядели одинаково во всех уведомлениях.
 */

// ── Словари доменных перечислений ────────────────────────────────────────

export const ABSENCE_TITLES: Record<AbsenceType, string> = {
  VACATION: 'отпуск',
  SICK_LEAVE: 'больничный',
  TIME_OFF: 'отгул',
  BUSINESS_TRIP: 'командировка',
  UNPAID: 'отпуск за свой счёт',
};

export const REQUEST_TITLES: Record<RequestType, string> = {
  VACATION: 'Отпуск',
  TIME_OFF: 'Отгул',
  OVERTIME: 'Переработка',
  SHIFT_SWAP: 'Обмен сменами',
  TIMESHEET_FIX: 'Корректировка табеля',
  TRIP: 'Командировка',
  PERIOD_CLOSE: 'Закрытие периода',
  WORK_ACT: 'Акт выполненных работ',
};

export const EMPLOYMENT_TITLES: Record<EmploymentType, string> = {
  LABOR_CONTRACT: 'трудовой договор',
  CIVIL_CONTRACT: 'договор ГПХ',
  SELF_EMPLOYED: 'самозанятый',
  ENTREPRENEUR: 'индивидуальный предприниматель',
  OUTSTAFF: 'аутстафф',
  INTERN: 'стажировка',
};

export const ROLE_TITLES: Record<string, string> = {
  EMPLOYEE: 'Сотрудник',
  MANAGER: 'Руководитель',
  HR: 'Кадровая служба',
  ADMIN: 'Администратор системы',
};

export function requestTitle(type: string): string {
  return REQUEST_TITLES[type as RequestType] ?? type;
}

export function absenceTitle(type: string): string {
  return ABSENCE_TITLES[type as AbsenceType] ?? type;
}

export function employmentTitle(type: string): string {
  return EMPLOYMENT_TITLES[type as EmploymentType] ?? type;
}

export function roleTitle(code: string): string {
  return ROLE_TITLES[code] ?? code;
}

// ── Форматирование ───────────────────────────────────────────────────────

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATE_SHORT_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/**
 * Календарная дата YYYY-MM-DD.
 *
 * Форматируется в UTC осознанно: это дата из табеля или графика, а не
 * момент времени. Приведение к местному поясу сервера сдвинуло бы её
 * на сутки для всех, кто западнее, — классическая ошибка «отпуск
 * начинается 14-го вместо 15-го».
 */
export function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? isoDate : DATE_FORMAT.format(parsed);
}

/** Период. Одинаковый год и месяц не повторяются: «с 1 по 14 сентября 2026 г.» */
export function formatPeriod(period: DatePeriod): string {
  if (period.from === period.to) return formatDate(period.from);

  const from = new Date(`${period.from}T00:00:00.000Z`);
  const to = new Date(`${period.to}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return `${period.from} — ${period.to}`;
  }

  const sameMonth =
    from.getUTCFullYear() === to.getUTCFullYear() && from.getUTCMonth() === to.getUTCMonth();
  const head = sameMonth ? String(from.getUTCDate()) : DATE_SHORT_FORMAT.format(from);
  return `с ${head} по ${DATE_FORMAT.format(to)}`;
}

/** Время из ISO-8601 в HH:MM указанной зоны. */
export function formatTime(iso: string, timeZone: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(parsed);
}

/** Минуты в «3 ч 30 мин». Табель считает в минутах, человек — в часах. */
export function formatMinutes(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const sign = minutes < 0 ? '−' : '';

  if (hours === 0) return `${sign}${rest} мин`;
  if (rest === 0) return `${sign}${hours} ч`;
  return `${sign}${hours} ч ${rest} мин`;
}

/** «5 задач» — согласование числительного с существительным. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];

/** Размер в человеческом виде. Делитель 1024: речь о месте на диске. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** Обрезка до длины с многоточием — превью сообщения в push. */
export function truncate(text: string, limit = 140): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Имя для обращения. Пустое ФИО в проекции — не повод писать «Здравствуйте, !». */
export function addressee(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[1];
  return first ?? fullName.trim();
}

// ── Ссылки в интерфейсе ──────────────────────────────────────────────────
//
// Пути SPA, а не REST api-gateway: по уведомлению переходит человек.
// Собраны в одном месте, потому что меняются вместе с маршрутизацией
// фронтенда, а не вместе с правилами уведомлений.

export const Links = {
  request: (requestId: string) => `/requests/${requestId}`,
  requestsInbox: () => '/requests/inbox',
  card: (boardId: string, cardId: string) => `/boards/${boardId}?card=${cardId}`,
  /** Когда доска в payload события не передана — интерфейс найдёт её сам. */
  cardById: (cardId: string) => `/cards/${cardId}`,
  board: (boardId: string) => `/boards/${boardId}`,
  channel: (channelId: string) => `/chat/${channelId}`,
  message: (channelId: string, messageId: string) => `/chat/${channelId}?message=${messageId}`,
  call: (roomId: string) => `/calls/${roomId}`,
  schedule: () => '/schedule',
  timesheet: (period?: string) => (period ? `/timesheet?period=${period}` : '/timesheet'),
  employee: (employeeId: string) => `/employees/${employeeId}`,
  security: () => '/profile/security',
  storage: () => '/admin/storage',
  files: () => '/files',
  passwordReset: (token: string) => `/reset-password?token=${encodeURIComponent(token)}`,
} as const;

// ── HTML-письмо ──────────────────────────────────────────────────────────

/**
 * Разметка письма.
 *
 * Таблица и инлайновые стили вместо разметки на flex/grid — не архаизм:
 * почтовые клиенты вырезают <style> и не поддерживают современную
 * раскладку, и письмо, красивое в браузере, в Outlook разъезжается
 * в столбик.
 */
export function renderEmail(input: {
  title: string;
  body: string;
  link?: string;
  linkText?: string;
  recipientName: string;
  footerNote?: string;
}): { html: string; text: string } {
  const greeting = input.recipientName ? `Здравствуйте, ${input.recipientName}!` : 'Здравствуйте!';
  const button = input.link
    ? `<tr><td style="padding:24px 32px 0 32px;">
         <a href="${escapeHtml(input.link)}"
            style="display:inline-block;padding:12px 24px;background:#2563eb;color:#ffffff;
                   text-decoration:none;border-radius:6px;font-weight:600;">
           ${escapeHtml(input.linkText ?? 'Открыть в системе')}
         </a>
       </td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f1f5f9;
             font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
       style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;
              border:1px solid #e2e8f0;">
  <tr><td style="padding:32px 32px 0 32px;">
    <p style="margin:0 0 16px 0;color:#64748b;font-size:14px;">${escapeHtml(greeting)}</p>
    <h1 style="margin:0;font-size:20px;line-height:28px;">${escapeHtml(input.title)}</h1>
  </td></tr>
  <tr><td style="padding:12px 32px 0 32px;">
    <p style="margin:0;font-size:15px;line-height:24px;color:#334155;">
      ${escapeHtml(input.body).replace(/\n/g, '<br>')}
    </p>
  </td></tr>
  ${button}
  <tr><td style="padding:32px;">
    <p style="margin:0;border-top:1px solid #e2e8f0;padding-top:16px;
              font-size:12px;line-height:18px;color:#94a3b8;">
      ${escapeHtml(input.footerNote ?? 'Письмо отправлено CRM автоматически, отвечать на него не нужно.')}
    </p>
  </td></tr>
</table>
</body></html>`;

  const text = [greeting, '', input.title, '', input.body, input.link ? `\n${input.link}` : '']
    .join('\n')
    .trim();

  return { html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
