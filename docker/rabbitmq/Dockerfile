# syntax=docker/dockerfile:1
# ════════════════════════════════════════════════════════════════════════════
#  RabbitMQ с плагином отложенных сообщений.
#
#  Плагин нужен обменнику crm.retry: повторы после ошибки обработки идут
#  с задержкой 5с → 30с → 5м (docs/architecture.md §7.1, §7.7). Штатный
#  AMQP такого не умеет — только TTL+DLX, где задержка задаётся на очередь,
#  а не на сообщение, и три разных интервала потребовали бы трёх очередей.
#
#  Если плагин недоступен (нет сети при сборке), система остаётся
#  работоспособной: assertTopology логирует предупреждение и пропускает
#  crm.retry, а отказы уходят в DLQ сразу, без промежуточных попыток.
#  См. libs/common/src/messaging/assert-topology.ts
# ════════════════════════════════════════════════════════════════════════════
FROM rabbitmq:4.1-management-alpine

# Версия плагина должна соответствовать мажорной версии брокера.
# Список релизов и точные имена ассетов:
#   https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases
ARG PLUGIN_VERSION=4.1.0
ARG PLUGIN_URL=https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v${PLUGIN_VERSION}/rabbitmq_delayed_message_exchange-${PLUGIN_VERSION}.ez

ADD --chown=rabbitmq:rabbitmq ${PLUGIN_URL} /opt/rabbitmq/plugins/rabbitmq_delayed_message_exchange.ez

RUN rabbitmq-plugins enable --offline rabbitmq_delayed_message_exchange
