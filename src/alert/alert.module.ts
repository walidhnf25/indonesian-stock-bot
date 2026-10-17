import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { MarketModule } from '../market/market.module';
import { StockModule } from '../stock/stock.module';
import { AlertService } from './alert.service';

@Module({
  imports: [StockModule, AnalysisModule, MarketModule],
  providers: [AlertService],
  exports: [AlertService],
})
export class AlertModule {}
