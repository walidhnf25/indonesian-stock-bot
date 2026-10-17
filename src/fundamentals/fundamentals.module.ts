import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module';
import { FundamentalsService } from './fundamentals.service';

@Module({
  imports: [StockModule],
  providers: [FundamentalsService],
  exports: [FundamentalsService],
})
export class FundamentalsModule {}
