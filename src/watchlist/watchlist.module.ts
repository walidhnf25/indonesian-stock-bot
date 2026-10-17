import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module';
import { WatchlistService } from './watchlist.service';

@Module({ imports: [StockModule], providers: [WatchlistService], exports: [WatchlistService] })
export class WatchlistModule {}
