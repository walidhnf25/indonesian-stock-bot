import { Injectable } from '@nestjs/common';
import { escapeHtml } from '../../common/utils/format';
import { SmallTalkKind } from '../../intent/intent.types';
import { smallTalkReply } from '../../telegram/policy-messages';
import { HELP_TEXT } from '../../telegram/telegram-response';
import { HandlerContext } from '../chat.types';

export const UNKNOWN_TEXT = [
  'Maaf, saya belum mengerti maksudmu 🙏',
  '',
  'Coba tulis kode saham atau pertanyaan seperti:',
  '• "BBCA"',
  '• "analisis BBRI"',
  '• "bandingkan BBCA BBRI"',
  '• "saham apa yang volumenya tinggi?"',
  '',
  'Ketik /help untuk contoh lengkap.',
].join('\n');

@Injectable()
export class GeneralHandler {
  help(): string[] {
    return [HELP_TEXT];
  }

  unknown(): string[] {
    return [UNKNOWN_TEXT];
  }

  /** Greetings / thanks / "ok": a fixed reply, no AI, no data providers. */
  smallTalk(ctx: HandlerContext): string[] {
    const p = ctx.intent.parameters as { kind?: SmallTalkKind; daypart?: string };
    return [escapeHtml(smallTalkReply(p.kind, p.daypart))];
  }
}
