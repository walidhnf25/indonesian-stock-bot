import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AlertModule } from '../alert/alert.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ConversationModule } from '../conversation/conversation.module';
import { FundamentalsModule } from '../fundamentals/fundamentals.module';
import { IntentModule } from '../intent/intent.module';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { ScreenerModule } from '../screener/screener.module';
import { StockModule } from '../stock/stock.module';
import { UserModule } from '../user/user.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { RagModule } from '../rag/rag.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { ChatService } from './chat.service';
import { GeneralHandler } from './handlers/general.handler';
import { KnowledgeHandler } from './handlers/knowledge.handler';
import { MemoryHandler } from './handlers/memory.handler';
import { PortfolioLedgerHandler } from './handlers/portfolio-ledger.handler';
import { WatchlistAlertHandler } from './handlers/watchlist-alert.handler';
import { StockHandler } from './handlers/stock.handler';

@Module({
  imports: [
    AIModule,
    AlertModule,
    AnalysisModule,
    ConversationModule,
    FundamentalsModule,
    IntentModule,
    MarketModule,
    NewsModule,
    PortfolioModule,
    RagModule,
    ScreenerModule,
    StockModule,
    UserModule,
    WatchlistModule,
  ],
  providers: [
    ChatService,
    GeneralHandler,
    KnowledgeHandler,
    MemoryHandler,
    WatchlistAlertHandler,
    PortfolioLedgerHandler,
    StockHandler,
  ],
  exports: [ChatService],
})
export class ChatModule {}
