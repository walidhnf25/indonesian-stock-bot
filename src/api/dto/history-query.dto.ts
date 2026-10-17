import { IsIn, IsOptional } from 'class-validator';
import { HistoryRange } from '../../stock/stock.types';

export const HISTORY_RANGES: HistoryRange[] = ['1mo', '3mo', '6mo', '1y', '2y'];

export class HistoryQueryDto {
  @IsOptional()
  @IsIn(HISTORY_RANGES)
  range?: HistoryRange;
}
