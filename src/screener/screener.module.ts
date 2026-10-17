import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { MarketModule } from '../market/market.module';
import { StockModule } from '../stock/stock.module';
import { ScreenerService } from './screener.service';

@Module({
  imports: [StockModule, AnalysisModule, MarketModule],
  providers: [ScreenerService],
  exports: [ScreenerService],
})
export class ScreenerModule {}
