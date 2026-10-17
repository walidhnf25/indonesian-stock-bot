import { Module } from '@nestjs/common';
import { createRequire } from 'node:module';
import { LoggerModule } from 'nestjs-pino';
import { AccessModule } from './access/access.module';
import { AlertModule } from './alert/alert.module';
import { ApiModule } from './api/api.module';
import { CommonModule } from './common/background-tasks.service';
import { AppConfigModule } from './config/config.module';
import { AppConfig } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { NotifierModule } from './notifier/notifier.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { TelegramModule } from './telegram/telegram.module';

/** pino-pretty is a devDependency: use it only when installed, so a production install never crashes on startup. */
function prettyAvailable(): boolean {
  try {
    createRequire(__filename).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

@Module({
  imports: [
    AppConfigModule,
    RedisModule,
    QueueModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              '*.token',
              '*.apiKey',
              '*.password',
            ],
            censor: '[REDACTED]',
          },
          transport:
            config.get('NODE_ENV') === 'production' || !prettyAvailable()
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss',
                    ignore: 'pid,hostname,req,res,responseTime',
                  },
                },
          autoLogging: { ignore: (req) => req.url === '/health' },
        },
      }),
    }),
    CommonModule,
    AccessModule,
    DatabaseModule,
    NotifierModule,
    AlertModule,
    TelegramModule,
    SchedulerModule,
    ApiModule,
  ],
})
export class AppModule {}
