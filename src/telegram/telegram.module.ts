import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ChatModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
