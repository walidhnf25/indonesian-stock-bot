import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config.service';
import { AppExceptionFilter } from './common/exceptions/app-exception.filter';
import { configureHttp } from './common/http-setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableShutdownHooks();

  const config = app.get(AppConfig);
  const host = config.get('HOST');
  const port = config.get('PORT');
  const allowRemote = config.get('REST_ALLOW_REMOTE');
  configureHttp(app, { allowRemote });
  await app.listen(port, host);
  if (allowRemote) {
    app
      .get(Logger)
      .warn(
        'REST_ALLOW_REMOTE=true: the REST API has no authentication; keep it behind a firewall or proxy.',
      );
  }
  app.get(Logger).log(`Indonesian Stock Bot listening on http://${host}:${port} (health: /health)`);
}

bootstrap().catch((err: unknown) => {
  // Env validation errors land here; they never contain secret values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
