import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module';
import { NewsService } from './news.service';

@Module({
  imports: [StockModule],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
