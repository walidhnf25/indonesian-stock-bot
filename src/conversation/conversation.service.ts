import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { ConversationState, ConversationTurn, IntentName } from '../intent/intent.types';

const MAX_REMEMBERED_SYMBOLS = 5;
/** How many recent lookups a chat keeps. Small on purpose: this is context, not a transcript. */
export const MAX_RECENT_TURNS = 10;
/** A "delete my data" request must be confirmed within this window. */
export const DELETION_CONFIRM_WINDOW_MS = 5 * 60_000;

/**
 * Short-term memory per user AND chat: the last mentioned tickers, the last intent and the last few
 * lookups (ticker + intent + time), stored in PostgreSQL with a configurable expiry
 * (`CONTEXT_TTL_MINUTES`, default 30). No chat transcripts are kept. A follow-up such as "bagaimana
 * supportnya?" only resolves against what was asked in the SAME chat, so a ticker looked up in private
 * is never surfaced in a group. Everything here is best effort: a failed read or write never
 * fails the user's request.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly ttlMs: number;
  private lastPrune = 0;

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfig,
  ) {
    this.ttlMs = config.get('CONTEXT_TTL_MINUTES') * 60_000;
  }

  /** The TTL in minutes, for user-facing explanations of what is remembered. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }

  async get(userId: string, chatId: number): Promise<ConversationState | null> {
    try {
      const row = await this.prisma.conversationContext.findUnique({
        where: { userId_chatId: { userId, chatId: BigInt(chatId) } },
      });
      if (!row || row.expiresAt.getTime() <= Date.now()) return null;
      const ctx = row.context as unknown as ConversationState;
      return Array.isArray(ctx?.lastSymbols) ? ctx : null;
    } catch (e) {
      this.logger.warn(`context read failed: ${safeErrorMessage(e)}`);
      return null;
    }
  }

  async remember(
    userId: string,
    chatId: number,
    symbols: string[],
    intent: IntentName,
  ): Promise<void> {
    if (symbols.length === 0) return;
    const now = new Date();
    try {
      const previous = await this.get(userId, chatId);
      const turn: ConversationTurn = {
        symbols: symbols.slice(0, MAX_REMEMBERED_SYMBOLS),
        intent,
        at: now.toISOString(),
      };
      const state: ConversationState = {
        lastSymbols: turn.symbols,
        lastIntent: intent,
        updatedAt: turn.at,
        recent: [turn, ...(previous?.recent ?? [])].slice(0, MAX_RECENT_TURNS),
        // a pending deletion request is kept only while nothing else happens in the chat
      };
      await this.write(userId, chatId, state, new Date(now.getTime() + this.ttlMs));
      await this.pruneExpired();
    } catch (e) {
      this.logger.warn(`context write failed: ${safeErrorMessage(e)}`);
    }
  }

  /** The recent lookups of this user in this chat, newest first (empty when nothing is remembered). */
  async recall(userId: string, chatId: number): Promise<ConversationTurn[]> {
    const state = await this.get(userId, chatId);
    if (!state) return [];
    if (Array.isArray(state.recent)) return state.recent;
    // a row written by an older version only has the last symbols
    return [
      { symbols: state.lastSymbols, intent: state.lastIntent ?? 'UNKNOWN', at: state.updatedAt },
    ];
  }

  /** Forgets everything remembered for this user in this chat. */
  async clear(userId: string, chatId: number): Promise<void> {
    await this.prisma.conversationContext.deleteMany({ where: { userId, chatId: BigInt(chatId) } });
  }

  /** Records that the user asked to delete their data; the request is valid for a few minutes. */
  async markDeletionRequested(userId: string, chatId: number): Promise<Date> {
    const until = new Date(Date.now() + DELETION_CONFIRM_WINDOW_MS);
    const previous = await this.get(userId, chatId);
    const state: ConversationState = {
      lastSymbols: previous?.lastSymbols ?? [],
      lastIntent: previous?.lastIntent,
      updatedAt: new Date().toISOString(),
      recent: previous?.recent,
      deletionRequestedUntil: until.toISOString(),
    };
    const expiresAt = new Date(Math.max(until.getTime(), Date.now() + this.ttlMs));
    await this.write(userId, chatId, state, expiresAt);
    return until;
  }

  /** True when a deletion request is pending and still valid; the request is consumed either way. */
  async takeDeletionRequest(userId: string, chatId: number): Promise<boolean> {
    const state = await this.get(userId, chatId);
    const until = state?.deletionRequestedUntil ? Date.parse(state.deletionRequestedUntil) : NaN;
    if (!state || !Number.isFinite(until)) return false;
    const { deletionRequestedUntil: _, ...rest } = state;
    await this.write(userId, chatId, rest, new Date(Date.now() + this.ttlMs));
    return until > Date.now();
  }

  private async write(
    userId: string,
    chatId: number,
    state: ConversationState,
    expiresAt: Date,
  ): Promise<void> {
    const context = state as unknown as Prisma.InputJsonValue;
    const chat = BigInt(chatId);
    await this.prisma.conversationContext.upsert({
      where: { userId_chatId: { userId, chatId: chat } },
      create: { userId, chatId: chat, context, expiresAt },
      update: { context, expiresAt },
    });
  }

  /** Opportunistic cleanup (at most every 10 minutes); the retention job does the same on its schedule. */
  private async pruneExpired(): Promise<void> {
    if (Date.now() - this.lastPrune < 10 * 60_000) return;
    this.lastPrune = Date.now();
    try {
      await this.prisma.conversationContext.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch {
      /* best effort */
    }
  }
}
