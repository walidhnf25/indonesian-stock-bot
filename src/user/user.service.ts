import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { readPreferences, UserPreferences } from './user-preferences';

export interface TelegramIdentity {
  telegramId: number;
  chatId: number;
  /** "private" | "group" | "supergroup" (default "private"). */
  chatType?: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /** Upserts the user keyed by Telegram ID. Stores only the minimum profile fields. */
  async upsertFromTelegram(identity: TelegramIdentity): Promise<User> {
    // User.chatId is the user's PRIVATE chat only. A message from a group must never overwrite it (a
    // private chat id equals the Telegram user id), otherwise anything addressed to "the user's
    // chat" would end up in whichever group they wrote in last.
    const privateChat =
      identity.chatType && identity.chatType !== 'private' ? identity.telegramId : identity.chatId;
    const data = {
      chatId: BigInt(privateChat),
      username: identity.username ?? null,
      firstName: identity.firstName ?? null,
      lastName: identity.lastName ?? null,
    };
    return this.prisma.user.upsert({
      where: { telegramId: BigInt(identity.telegramId) },
      create: { telegramId: BigInt(identity.telegramId), ...data, language: 'id' },
      update: data,
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Sets (or with null clears) the default ticker; the stored object only ever holds allowlisted keys. */
  async setDefaultSymbol(userId: string, symbol: string | null): Promise<UserPreferences> {
    return this.updatePreferences(userId, (next) => {
      if (symbol) next.defaultSymbol = symbol;
      else delete next.defaultSymbol;
    });
  }

  /** How answers are presented (ringkas/lengkap). */
  async setDetail(userId: string, detail: UserPreferences['detail']): Promise<UserPreferences> {
    return this.updatePreferences(userId, (next) => {
      if (detail) next.detail = detail;
      else delete next.detail;
    });
  }

  private async updatePreferences(
    userId: string,
    mutate: (next: UserPreferences) => void,
  ): Promise<UserPreferences> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const next: UserPreferences = { ...readPreferences(user.preferences) };
    mutate(next);
    await this.prisma.user.update({
      where: { id: userId },
      data: { preferences: next as unknown as Prisma.InputJsonObject },
    });
    return next;
  }
}
