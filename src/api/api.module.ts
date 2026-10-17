import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HealthController } from '../health/health.controller';
import { ReadinessController } from '../health/readiness.controller';
import { MetricsController } from './metrics.controller';
import { StockController } from './stock.controller';

@Module({
  imports: [AIModule, AnalysisModule, StockModule, TelegramModule],
  controllers: [HealthController, ReadinessController, StockController, MetricsController],
})
export class ApiModule {}
