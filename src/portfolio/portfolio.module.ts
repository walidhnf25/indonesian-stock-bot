import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { StockModule } from '../stock/stock.module';
import { PortfolioSnapshotService } from './portfolio-snapshot.service';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [StockModule, MarketModule],
  providers: [PortfolioService, PortfolioSnapshotService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
