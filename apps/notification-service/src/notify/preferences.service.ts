import { Injectable } from '@nestjs/common';
import { Channel, type ChannelPreference, type Preference } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import type { QuietHours } from './quiet-hours';

/** Настройки в разрешённом виде: умолчания уже подставлены. */
export interface ResolvedPreferences {
  userId: string;
  channels: Record<Channel, { enabled: boolean; mutedEventTypes: string[] }>;
  quietHours: QuietHours;
}

/**
 * Умолчания живут в коде, а не строками в базе.
 *
 * Иначе изменение политики по умолчанию превращается в миграцию, которая
 * обязана отличить «пользователь согласен с умолчанием» от «пользователь
 * явно выбрал то же самое» — а эти два состояния в такой схеме
 * неразличимы. Здесь строка появляется только при явной настройке.
 */
const DEFAULT_CHANNEL = { enabled: true, mutedEventTypes: [] as string[] };
const DEFAULT_QUIET_FROM = '22:00';
const DEFAULT_QUIET_TO = '08:00';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string): Promise<ResolvedPreferences> {
    const [preference, channels, contact] = await Promise.all([
      this.prisma.preference.findUnique({ where: { userId } }),
      this.prisma.channelPreference.findMany({ where: { userId } }),
      this.prisma.contact.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);

    return build(userId, preference, channels, contact?.timezone ?? 'Europe/Moscow');
  }

  /** Настройки пачкой: рассылка на отдел не должна делать запрос на человека. */
  async resolveMany(userIds: string[]): Promise<Map<string, ResolvedPreferences>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();

    const [preferences, channels, contacts] = await Promise.all([
      this.prisma.preference.findMany({ where: { userId: { in: unique } } }),
      this.prisma.channelPreference.findMany({ where: { userId: { in: unique } } }),
      this.prisma.contact.findMany({
        where: { userId: { in: unique } },
        select: { userId: true, timezone: true },
      }),
    ]);

    const byUser = new Map<string, ResolvedPreferences>();
    for (const userId of unique) {
      byUser.set(
        userId,
        build(
          userId,
          preferences.find((item) => item.userId === userId) ?? null,
          channels.filter((item) => item.userId === userId),
          contacts.find((item) => item.userId === userId)?.timezone ?? 'Europe/Moscow',
        ),
      );
    }
    return byUser;
  }

  /**
   * Сохранение настроек.
   *
   * Каналы перезаписываются целиком, а не сливаются: интерфейс всегда
   * присылает полный набор, и частичное обновление привело бы к тому,
   * что выключенный канал, пропавший из запроса, тихо остался бы
   * включённым.
   */
  async update(
    userId: string,
    input: {
      channels?: { channel: Channel; enabled: boolean; mutedEventTypes: string[] }[];
      quietHours?: QuietHours;
    },
  ): Promise<ResolvedPreferences> {
    await this.prisma.$transaction(async (tx) => {
      if (input.quietHours) {
        const quiet = input.quietHours;
        await tx.preference.upsert({
          where: { userId },
          create: {
            userId,
            quietHoursEnabled: quiet.enabled,
            quietFrom: quiet.from || DEFAULT_QUIET_FROM,
            quietTo: quiet.to || DEFAULT_QUIET_TO,
          },
          update: {
            quietHoursEnabled: quiet.enabled,
            quietFrom: quiet.from || DEFAULT_QUIET_FROM,
            quietTo: quiet.to || DEFAULT_QUIET_TO,
          },
        });
        if (quiet.timezone) {
          await tx.contact.update({ where: { userId }, data: { timezone: quiet.timezone } });
        }
      }

      for (const channel of input.channels ?? []) {
        await tx.channelPreference.upsert({
          where: { userId_channel: { userId, channel: channel.channel } },
          create: {
            userId,
            channel: channel.channel,
            enabled: channel.enabled,
            mutedEventTypes: channel.mutedEventTypes,
          },
          update: { enabled: channel.enabled, mutedEventTypes: channel.mutedEventTypes },
        });
      }
    });

    return this.resolve(userId);
  }
}

/** Разрешён ли канал для конкретного типа события. */
export function allows(
  preferences: ResolvedPreferences,
  channel: Channel,
  eventType: string,
): boolean {
  const settings = preferences.channels[channel];
  return settings.enabled && !settings.mutedEventTypes.includes(eventType);
}

function build(
  userId: string,
  preference: Preference | null,
  channels: ChannelPreference[],
  timezone: string,
): ResolvedPreferences {
  const resolved = {
    [Channel.EMAIL]: { ...DEFAULT_CHANNEL },
    [Channel.WEB_PUSH]: { ...DEFAULT_CHANNEL },
    [Channel.IN_APP]: { ...DEFAULT_CHANNEL },
  };

  for (const item of channels) {
    resolved[item.channel] = { enabled: item.enabled, mutedEventTypes: item.mutedEventTypes };
  }

  return {
    userId,
    channels: resolved,
    quietHours: {
      enabled: preference?.quietHoursEnabled ?? false,
      from: preference?.quietFrom ?? DEFAULT_QUIET_FROM,
      to: preference?.quietTo ?? DEFAULT_QUIET_TO,
      timezone,
    },
  };
}
