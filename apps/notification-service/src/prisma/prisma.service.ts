import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma';

/**
 * Подключение к собственной базе сервиса.
 *
 * onModuleInit подключается явно, а не лениво при первом запросе: иначе
 * недоступная база обнаружится на первом пользовательском запросе, а не
 * при старте контейнера, и readiness-проба успеет отрапортовать «готов».
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log({ message: 'подключение к базе установлено' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
