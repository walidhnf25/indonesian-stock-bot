import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { StockModule } from '../stock/stock.module';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [StockModule, MarketModule],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
