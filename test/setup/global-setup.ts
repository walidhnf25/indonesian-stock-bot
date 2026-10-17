import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabase } from '../../src/testing/db-guard';

/**
 * Integration/e2e tests use a SEPARATE database (ai_stock_test) on the same local PostgreSQL,
 * so they never touch development data. The database is created if missing and migrated.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5436/ai_stock_test';

export default async function globalSetup(): Promise<void> {
  const { database: dbName } = assertSafeTestDatabase(TEST_DATABASE_URL);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    const rows = await admin.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${dbName}') AS exists`,
    );
    if (!rows[0]?.exists) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
