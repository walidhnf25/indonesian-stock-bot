/**
 * Terminal chat for trying the bot without Telegram:
 *   npm run chat                 interactive
 *   npm run chat -- "analisis BBCA"   one-shot
 * Uses the same ChatService pipeline as the Telegram bot (real DB, provider and AI).
 */
import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AccessModule } from '../access/access.module';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import { CommonModule } from '../common/background-tasks.service';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { NotifierModule } from '../notifier/notifier.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    AccessModule,
    DatabaseModule,
    NotifierModule,
    ChatModule,
  ],
})
class CliModule {}

const plain = (html: string) =>
  html
    .replace(/<\/?(b|i|code)>/g, '')
    .replace(/<pre>|<\/pre>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  const chat = app.get(ChatService);
  const userId = Number(process.env.CHAT_USER_ID ?? 900000001);

  const ask = async (text: string) => {
    const reply = await chat.handle({
      telegramId: userId,
      chatId: userId,
      username: 'cli_user',
      firstName: 'CLI',
      trusted: true, // local terminal tool: not a Telegram sender, bypasses the allowlist by design
      text,
      progress: async (m) => console.log(plain(m)),
    });
    for (const m of reply.messages) console.log(`\n${plain(m)}\n`);
  };

  const oneShot = process.argv.slice(2).join(' ').trim();
  if (oneShot) {
    await ask(oneShot);
  } else if (!process.stdin.isTTY) {
    // Piped input: read every line first, then answer them one by one.
    const lines: string[] = [];
    for await (const raw of createInterface({ input: process.stdin })) lines.push(raw.trim());
    for (const line of lines) {
      if (/^(exit|quit|keluar)$/i.test(line)) break;
      if (!line) continue;
      console.log(`> ${line}`);
      await ask(line);
    }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    console.log('Indonesian Stock Bot — terminal chat. Ketik pesan, atau "exit" untuk keluar.\n');
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (/^(exit|quit|keluar)$/i.test(line)) break;
      if (line) await ask(line);
      rl.prompt();
    }
    rl.close();
  }
  await app.close();
}

void main();
