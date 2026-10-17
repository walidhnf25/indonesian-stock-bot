import { Module } from '@nestjs/common';
import { STOCK_DATA_PROVIDER } from './stock-data-provider.interface';
import { MarketDataGovernor } from './governance/market-data-governor';
import { TickerRegistry } from './governance/ticker-registry';
import { StockService } from './stock.service';
import { YahooProvider } from './providers/yahoo.provider';
import { AppConfig } from '../config/app-config.service';
import { NEWS_PROVIDER, NullNewsProvider } from '../news/news-provider.interface';
import { YahooNewsProvider } from '../news/providers/yahoo-news.provider';

@Module({
  providers: [
    YahooProvider,
    // New providers register here and are selected via STOCK_DATA_PROVIDER.
    { provide: STOCK_DATA_PROVIDER, useExisting: YahooProvider },
    YahooNewsProvider,
    // News sources are selected via NEWS_PROVIDER; 'none' answers "not available" honestly.
    {
      provide: NEWS_PROVIDER,
      useFactory: (config: AppConfig, yahoo: YahooNewsProvider) =>
        config.get('NEWS_PROVIDER') === 'yahoo' ? yahoo : new NullNewsProvider(),
      inject: [AppConfig, YahooNewsProvider],
    },
    MarketDataGovernor,
    TickerRegistry,
    StockService,
  ],
  exports: [StockService, MarketDataGovernor, TickerRegistry, NEWS_PROVIDER],
})
export class StockModule {}
