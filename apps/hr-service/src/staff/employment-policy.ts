import { EmploymentType, PaymentForm, TimeTrackingPolicy } from '../../generated/prisma';

/**
 * Вывод политики учёта времени из типа найма и формы оплаты.
 * docs/architecture.md §3.2, §3.3, ADR-2
 *
 * Это — центральное доменное правило системы. Всё остальное ветвится по
 * ЕГО результату, а не по типу найма напрямую: добавление нового типа
 * найма сводится к строке в таблице ниже и не требует правок в табеле,
 * согласованиях, уведомлениях и отчётности.
 */

const POLICY_MATRIX: Partial<Record<EmploymentType, Partial<Record<PaymentForm, TimeTrackingPolicy>>>> =
  {
    LABOR_CONTRACT: {
      SALARY: 'NORM_BASED',
      HOURLY: 'FACT_BASED',
      PIECEWORK: 'DELIVERABLE_BASED',
      PER_ACT: 'DELIVERABLE_BASED',
    },
    INTERN: {
      SALARY: 'NORM_BASED',
      HOURLY: 'FACT_BASED',
    },
    // Табель ведёт компания-работодатель; у нас — справочно по графику
    OUTSTAFF: {
      SALARY: 'NORM_BASED',
      HOURLY: 'FACT_BASED',
    },
    // ГПХ, самозанятые и ИП: учёт рабочего времени НЕ ВЕДЁТСЯ.
    // Это не «функция отключена», а защитное поведение по умолчанию (§3.3).
    CIVIL_CONTRACT: {
      PER_ACT: 'DELIVERABLE_BASED',
      PIECEWORK: 'DELIVERABLE_BASED',
    },
    SELF_EMPLOYED: {
      PER_ACT: 'NONE',
      PIECEWORK: 'NONE',
    },
    ENTREPRENEUR: {
      PER_ACT: 'NONE',
    },
  };

export function derivePolicy(
  type: EmploymentType,
  paymentForm: PaymentForm,
): TimeTrackingPolicy {
  const policy = POLICY_MATRIX[type]?.[paymentForm];
  if (policy) return policy;

  // Неописанная комбинация трактуется как «время не учитываем».
  // Безопасная сторона отказа: завести лишний график и табель на
  // исполнителя по ГПХ хуже, чем не завести их сотруднику в штате —
  // первое создаёт признак трудовых отношений в гражданском договоре.
  return 'NONE';
}

/**
 * Применимость подсистем к политике (§3.3).
 * Отсюда approval-service узнаёт, какие типы заявок вообще доступны
 * сотруднику, и отклоняет неприменимые ещё до вовлечения руководителя.
 */
export interface PolicyCapabilities {
  /** График работы и смены */
  schedule: boolean;
  /** Табель рабочего времени */
  timesheet: boolean;
  /** Отпуск, отгул, больничный */
  leave: boolean;
  /** Заявка на переработку */
  overtime: boolean;
  /** Фактический учёт прихода/ухода (сегодня нигде не реализован) */
  attendance: boolean;
  /** Отчётность по закрытым задачам вместо времени */
  deliverables: boolean;
}

const CAPABILITIES: Record<TimeTrackingPolicy, PolicyCapabilities> = {
  NORM_BASED: {
    schedule: true,
    timesheet: true,
    leave: true,
    overtime: true,
    attendance: false,
    deliverables: false,
  },
  FACT_BASED: {
    schedule: true,
    timesheet: true,
    leave: true,
    // Переработка вычисляется из факта, а не запрашивается заявкой
    overtime: false,
    attendance: true,
    deliverables: false,
  },
  DELIVERABLE_BASED: {
    schedule: false,
    timesheet: false,
    leave: false,
    overtime: false,
    attendance: false,
    deliverables: true,
  },
  NONE: {
    schedule: false,
    timesheet: false,
    leave: false,
    overtime: false,
    attendance: false,
    deliverables: false,
  },
};

export function capabilitiesOf(policy: TimeTrackingPolicy): PolicyCapabilities {
  return CAPABILITIES[policy];
}

/**
 * Требует ли политика фактического учёта, которого в системе нет.
 * Задел §3.4: сотрудника с такой политикой завести можно, но табель по
 * нему рассчитать не удастся, пока не появится attendance-service.
 */
export function requiresUnimplementedTracking(policy: TimeTrackingPolicy): boolean {
  return policy === 'FACT_BASED';
}
