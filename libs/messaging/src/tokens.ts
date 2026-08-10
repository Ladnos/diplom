/** DI-токены библиотеки обмена сообщениями. */

/** ClientProxy, публикующий в обменник crm.events. */
export const EVENTS_CLIENT = Symbol('EVENTS_CLIENT');

/** ClientProxy, публикующий в обменник crm.commands. */
export const COMMANDS_CLIENT = Symbol('COMMANDS_CLIENT');

/** Хранилище обработанных eventId — идемпотентность потребителя. */
export const PROCESSED_EVENT_STORE = Symbol('PROCESSED_EVENT_STORE');

/** Хранилище исходящих событий — транзакционный outbox. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
