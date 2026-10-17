import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);
  private connected = false;

  get isConnected(): boolean {
    return this.connected;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.connected = true;
    } catch {
      // The app stays up so /health can report the problem; DB-backed features degrade.
      this.logger.error(
        'Database is unreachable. Check DATABASE_URL and that PostgreSQL is running.',
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      this.connected = true;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }
}
