import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { IntentService } from './intent.service';

@Module({ imports: [AIModule], providers: [IntentService], exports: [IntentService] })
export class IntentModule {}
