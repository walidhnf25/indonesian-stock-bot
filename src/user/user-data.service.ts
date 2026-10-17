import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface DeletionSummary {
  watchlistItems: number;
  alerts: number;
  portfolioTransactions: number;
  analyses: number;
  contexts: number;
  notes: number;
}

/**
 * Deletes everything Indonesian Stock Bot stores about a user ("hapus data saya"): profile, preferences,
 * watchlists, alerts, portfolio ledger and snapshots, AI analyses and conversation context. The user row
 * is deleted and every dependent table cascades (see `onDelete: Cascade` in the schema), inside one
 * transaction, so a partial deletion is impossible. Market data (stocks, quotes, candles) is shared and
 * is not touched. The profile is recreated automatically on the next message.
 */
@Injectable()
export class UserDataService {
  private readonly logger = new Logger(UserDataService.name);

  constructor(private readonly prisma: PrismaService) {}

  async deleteAll(userId: string): Promise<DeletionSummary> {
    const summary = await this.prisma.$transaction(async (tx) => {
      const [watchlistItems, alerts, portfolioTransactions, analyses, contexts, notes] =
        await Promise.all([
          tx.watchlistItem.count({ where: { watchlist: { userId } } }),
          tx.alert.count({ where: { userId } }),
          tx.portfolioTransaction.count({ where: { portfolio: { userId } } }),
          tx.aIAnalysis.count({ where: { userId } }),
          tx.conversationContext.count({ where: { userId } }),
          tx.knowledgeDocument.count({ where: { userId, source: 'note' } }),
        ]);
      await tx.user.deleteMany({ where: { id: userId } });
      return { watchlistItems, alerts, portfolioTransactions, analyses, contexts, notes };
    });
    // counts only: the log must not say who was deleted
    this.logger.log(JSON.stringify({ evt: 'USER_DATA_DELETED', ...summary }));
    return summary;
  }
}
