import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { normalizeTicker } from '../utils/ticker';

@Injectable()
export class SymbolPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const symbol = normalizeTicker(value);
    if (!symbol) throw new BadRequestException('Ticker harus 4 huruf (mis. BBCA).');
    return symbol;
  }
}
