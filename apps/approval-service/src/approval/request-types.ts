import type { RequestType } from '../../generated/prisma';

/**
 * Правила по типам заявок. docs/architecture.md ADR-3
 *
 * Таблица лежит в коде, а не в настройках, по той же причине, что и
 * матрица прав: маршрут согласования — часть контракта системы, его
 * изменение должно проходить ревью и попадать в историю git, а не
 * применяться кликом. Кто именно согласует — наоборот, операционные
 * данные, и они берутся из оргструктуры в момент подачи.
 */

/**
 * Политика учёта времени сотрудника (зеркало enum из hr.proto).
 * Дублируется здесь, а не импортируется: approval-service не имеет
 * доступа к схеме hr_db, а строковые значения приходят по gRPC.
 */
export type TimeTrackingPolicy = 'NORM_BASED' | 'FACT_BASED' | 'DELIVERABLE_BASED' | 'NONE';

export interface RequestTypeRule {
  /** Сколько уровней руководителей участвует в согласовании. */
  managerLevels: number;
  /** Нужен ли отдельный шаг кадровой службы. */
  requiresHr: boolean;
  /** Срок рассмотрения. По истечении планировщик эскалирует заявку. */
  slaHours: number;
  /**
   * Политики учёта, при которых заявка применима (§3.3).
   * Пустой список — применима всем.
   */
  policies: TimeTrackingPolicy[];
  /** Человекочитаемое название для интерфейса и уведомлений. */
  title: string;
}

export const REQUEST_RULES: Record<RequestType, RequestTypeRule> = {
  VACATION: {
    managerLevels: 1,
    requiresHr: true,
    slaHours: 72,
    // Право на отпуск даёт трудовой договор. Исполнитель по ГПХ и
    // самозанятый его не имеют — заявка не создаётся вовсе (§3.3).
    policies: ['NORM_BASED', 'FACT_BASED'],
    title: 'Отпуск',
  },
  TIME_OFF: {
    managerLevels: 1,
    requiresHr: false,
    slaHours: 24,
    policies: ['NORM_BASED', 'FACT_BASED'],
    title: 'Отгул или больничный',
  },
  OVERTIME: {
    managerLevels: 1,
    requiresHr: false,
    slaHours: 48,
    // При почасовой оплате переработка выводится из фактического учёта,
    // а не запрашивается заявкой.
    policies: ['NORM_BASED'],
    title: 'Переработка',
  },
  SHIFT_SWAP: {
    managerLevels: 1,
    requiresHr: false,
    slaHours: 24,
    policies: ['NORM_BASED', 'FACT_BASED'],
    title: 'Обмен сменами',
  },
  TIMESHEET_FIX: {
    managerLevels: 1,
    requiresHr: true,
    slaHours: 48,
    policies: ['NORM_BASED', 'FACT_BASED'],
    title: 'Корректировка табеля',
  },
  TRIP: {
    managerLevels: 1,
    requiresHr: true,
    slaHours: 72,
    policies: ['NORM_BASED', 'FACT_BASED'],
    title: 'Командировка',
  },
  PERIOD_CLOSE: {
    // Закрытие табеля инициирует кадровая служба, утверждает руководитель
    managerLevels: 1,
    requiresHr: false,
    slaHours: 24,
    policies: [],
    title: 'Закрытие табеля за период',
  },
  WORK_ACT: {
    managerLevels: 1,
    requiresHr: true,
    slaHours: 120,
    // Акт выполненных работ — наоборот, только для тех, у кого время
    // не учитывается: ГПХ и сдельщики отчитываются результатом.
    policies: ['DELIVERABLE_BASED', 'NONE'],
    title: 'Акт выполненных работ',
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Проверка тела заявки.
 *
 * Выполняется до построения маршрута: заявка с датой отпуска «вчера—
 * позавчера» не должна доходить до руководителя и тратить его внимание.
 * Возвращает текст ошибки либо null.
 */
export function validatePayload(type: RequestType, payload: Record<string, unknown>): string | null {
  const date = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' && ISO_DATE.test(value) ? value : null;
  };
  const positiveInt = (key: string): number | null => {
    const value = Number(payload[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };

  switch (type) {
    case 'VACATION':
    case 'TIME_OFF':
    case 'TRIP': {
      const from = date('from');
      const to = date('to');
      if (!from || !to) return 'укажите даты from и to в формате YYYY-MM-DD';
      if (from > to) return 'дата окончания раньше даты начала';
      return null;
    }

    case 'OVERTIME': {
      if (!date('date')) return 'укажите дату date в формате YYYY-MM-DD';
      const minutes = positiveInt('minutes');
      if (!minutes) return 'укажите переработку в минутах';
      if (minutes > 12 * 60) return 'переработка не может превышать 12 часов';
      return null;
    }

    case 'TIMESHEET_FIX': {
      if (!date('date')) return 'укажите дату date в формате YYYY-MM-DD';
      const total = Number(payload.totalMinutes);
      if (!Number.isInteger(total) || total < 0 || total > 24 * 60) {
        return 'укажите итог за день totalMinutes от 0 до 1440 минут';
      }
      return null;
    }

    case 'SHIFT_SWAP': {
      if (!date('date')) return 'укажите дату смены date';
      if (typeof payload.withEmployeeId !== 'string' || !payload.withEmployeeId) {
        return 'укажите withEmployeeId — с кем меняетесь сменой';
      }
      return null;
    }

    case 'PERIOD_CLOSE': {
      const from = date('from');
      const to = date('to');
      if (!from || !to) return 'укажите период from и to';
      if (from > to) return 'дата окончания раньше даты начала';
      return null;
    }

    case 'WORK_ACT': {
      const from = date('from');
      const to = date('to');
      if (!from || !to) return 'укажите отчётный период from и to';
      return null;
    }

    default:
      return `неизвестный тип заявки: ${String(type)}`;
  }
}

/** Применим ли тип заявки к политике учёта сотрудника (§3.3). */
export function isApplicable(type: RequestType, policy: TimeTrackingPolicy): boolean {
  const rule = REQUEST_RULES[type];
  return rule.policies.length === 0 || rule.policies.includes(policy);
}

/** Типы заявок, доступные сотруднику с данной политикой учёта. */
export function availableTypes(policy: TimeTrackingPolicy): RequestType[] {
  return (Object.keys(REQUEST_RULES) as RequestType[]).filter((type) =>
    isApplicable(type, policy),
  );
}
