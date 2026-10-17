import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { activeKeyOf } from '../../src/alert/alert.service';
import { assertSafeTestDatabase } from '../../src/testing/db-guard';
import { TEST_DATABASE_URL } from '../setup/global-setup';

/**
 * Data-migration tests: the schema is brought to the state BEFORE each migration,
 * realistic rows are seeded, the migration is applied and the result is checked. Runs on a private,
 * throw-away database whose name still has to pass the test-database guard.
 */
const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'prisma', 'migrations');
const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_migr`; // ai_stock_test_migr: still "test" as a whole word
const DB_URL = url.toString();
const { database: DB_NAME } = assertSafeTestDatabase(DB_URL);

const ACTIVE_KEY = '20261004120000_alert_active_key_and_context_scope';
const CANONICAL_KEY = '20261004140000_alert_active_key_canonical';
const QUANTIZED_THRESHOLDS = '20261004160000_alert_threshold_quantize';

describe('data migrations on a seeded database', () => {
  let work: string;
  let db: PrismaClient;

  const deploy = (upTo: string) => {
    // a prisma project made of the real schema and only the migrations up to (and including) `upTo`
    rmSync(join(work, 'prisma', 'migrations'), { recursive: true, force: true });
    mkdirSync(join(work, 'prisma', 'migrations'), { recursive: true });
    for (const name of readdirSync(MIGRATIONS).sort()) {
      if (name === 'migration_lock.toml' || name <= upTo) {
        cpSync(join(MIGRATIONS, name), join(work, 'prisma', 'migrations', name), {
          recursive: true,
        });
      }
    }
    execSync(
      'npx prisma migrate deploy --schema ' + JSON.stringify(join(work, 'prisma', 'schema.prisma')),
      {
        cwd: REPO,
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: DB_URL },
      },
    );
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'stock-bot-migr-'));
    mkdirSync(join(work, 'prisma'), { recursive: true });
    cpSync(join(REPO, 'prisma', 'schema.prisma'), join(work, 'prisma', 'schema.prisma'));
    const adminUrl = new URL(DB_URL);
    adminUrl.pathname = '/postgres';
    const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);
    } finally {
      await admin.$disconnect();
    }
    db = new PrismaClient({ datasourceUrl: DB_URL });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    const adminUrl = new URL(DB_URL);
    adminUrl.pathname = '/postgres';
    const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
    rmSync(work, { recursive: true, force: true });
  });

  const alertRow = (
    id: string,
    userId: string,
    stockId: string,
    threshold: string,
    createdAt: string,
    status = 'ACTIVE',
    chatId = '111',
  ) =>
    db.$executeRawUnsafe(
      `INSERT INTO "Alert" ("id","userId","stockId","type","threshold","status","chatId","chatType","createdAt","updatedAt")
       VALUES ('${id}','${userId}','${stockId}','PRICE_ABOVE',${threshold},'${status}'::"AlertStatus",${chatId},'private','${createdAt}','${createdAt}')`,
    );

  it('duplicate ACTIVE alerts are reduced to the oldest, contexts get their chat id, keys are filled', async () => {
    deploy('20261003130000_alert_chat_scope'); // the state the owner's database was in before the activeKey migration
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id","telegramId","chatId","updatedAt") VALUES ('u1',111,111,now()),('u2',222,222,now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Stock" ("id","symbol","updatedAt") VALUES ('s1','TSTA',now()),('s2','TSTB',now())`,
    );
    // three identical ACTIVE alerts of u1 (oldest = a1), one different, one already TRIGGERED, one of u2
    await alertRow('a1', 'u1', 's1', '5000', '2026-10-01T00:00:00Z');
    await alertRow('a2', 'u1', 's1', '5000', '2026-10-02T00:00:00Z');
    await alertRow('a3', 'u1', 's1', '5000', '2026-10-03T00:00:00Z');
    await alertRow('a4', 'u1', 's2', '5000', '2026-10-01T00:00:00Z');
    await alertRow('a5', 'u1', 's1', '5000', '2026-10-01T00:00:00Z', 'TRIGGERED');
    await alertRow('a6', 'u2', 's1', '5000', '2026-10-01T00:00:00Z', 'ACTIVE', '222');
    await db.$executeRawUnsafe(
      `INSERT INTO "ConversationContext" ("id","userId","context","expiresAt","updatedAt") VALUES ('c1','u1','{}'::jsonb, now() + interval '1 day', now())`,
    );

    deploy(ACTIVE_KEY);

    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; status: string; activeKey: string | null }>
    >(`SELECT "id","status"::text AS status,"activeKey" FROM "Alert" ORDER BY "id"`);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.a1.status).toBe('ACTIVE');
    expect(by.a2.status).toBe('DISABLED');
    expect(by.a3.status).toBe('DISABLED');
    expect(by.a4.status).toBe('ACTIVE'); // different stock: untouched
    expect(by.a5.status).toBe('TRIGGERED'); // history is never touched
    expect(by.a6.status).toBe('ACTIVE'); // another user with the same alert: untouched
    expect(by.a1.activeKey).toBe('u1:s1:PRICE_ABOVE:5000:111');
    expect(by.a5.activeKey).toBeNull();
    expect(by.a2.activeKey).toBeNull();
    expect(await db.alert.count()).toBe(6); // nothing deleted

    const ctx = await db.$queryRawUnsafe<Array<{ chatId: bigint }>>(
      `SELECT "chatId" FROM "ConversationContext" WHERE "id"='c1'`,
    );
    expect(ctx[0].chatId).toBe(111n); // the owner's private chat
  }, 180_000);

  it('exotic thresholds are re-keyed in the exact form the application builds', async () => {
    // after the activeKey migration the database holds keys such as "...:1e-05:..." (float8::text); seed some on purpose
    await db.$executeRawUnsafe(`DELETE FROM "Alert"`);
    await alertRow('b1', 'u1', 's1', '0.00001', '2026-10-01T00:00:00Z');
    await alertRow('b2', 'u1', 's1', '1000000000000000', '2026-10-01T00:00:00Z');
    await alertRow('b3', 'u1', 's1', '0.1', '2026-10-01T00:00:00Z', 'ACTIVE', '333');
    // 0.30000000000000004 and 0.3 are two different doubles but the same threshold for the user
    await alertRow('b4', 'u1', 's2', '0.30000000000000004', '2026-10-02T00:00:00Z');
    await alertRow('b5', 'u1', 's2', '0.3', '2026-10-01T00:00:00Z');
    // the activeKey migration ran already, so seeded rows have no key yet: give them the OLD (PG) format
    await db.$executeRawUnsafe(
      `UPDATE "Alert" SET "activeKey" = "userId" || ':' || "stockId" || ':' || "type"::text || ':' || "threshold"::text || ':' || COALESCE("chatId"::text, '') WHERE "status"='ACTIVE'`,
    );
    const old = await db.$queryRawUnsafe<Array<{ activeKey: string }>>(
      `SELECT "activeKey" FROM "Alert" WHERE "id" = 'b1'`,
    );
    expect(old[0].activeKey).toContain('1e-05'); // the mismatch this migration exists to repair

    deploy(CANONICAL_KEY);

    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        status: string;
        activeKey: string | null;
        userId: string;
        stockId: string;
        threshold: number;
        chatId: bigint | null;
      }>
    >(
      `SELECT "id","status"::text AS status,"activeKey","userId","stockId","threshold","chatId" FROM "Alert"`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const id of ['b1', 'b2', 'b3', 'b5']) {
      expect(by[id].status).toBe('ACTIVE');
      expect(by[id].activeKey).toBe(
        activeKeyOf({
          userId: by[id].userId,
          stockId: by[id].stockId,
          type: 'PRICE_ABOVE',
          threshold: by[id].threshold,
          chatId: by[id].chatId,
        }),
      );
    }
    expect(by.b1.activeKey).toBe('u1:s1:PRICE_ABOVE:0.00001:111');
    expect(by.b2.activeKey).toBe('u1:s1:PRICE_ABOVE:1000000000000000:111');
    // b4 is the same threshold as the older b5 once canonical: the newer one is disabled, nothing deleted
    expect(by.b4).toMatchObject({ status: 'DISABLED', activeKey: null });
    expect(rows).toHaveLength(5);
  }, 180_000);

  it('half-way legacy thresholds are quantised, and every key then equals the one the application builds', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "Alert"`);
    const seeds: Array<[string, string, string, string]> = [
      // id, stock, threshold, createdAt
      ['c1', 's1', '0.1234565', '2026-10-01T00:00:00Z'],
      ['c2', 's1', '4.0000005', '2026-10-01T00:00:00Z'],
      ['c3', 's1', '123456789.123457', '2026-10-01T00:00:00Z'],
      ['c8', 's1', '9007199254.740993', '2026-10-01T00:00:00Z'], // above the 1e9 limit: disabled
      ['c4', 's1', '8500', '2026-10-01T00:00:00Z'],
      ['c5', 's2', '0.1234561', '2026-10-01T00:00:00Z'],
      // not a usable threshold at 6 decimals: disabled, not turned into "above 0"
      ['c7', 's2', '0.0000001', '2026-10-01T00:00:00Z'],
    ];
    for (const [id, stock, thr, at] of seeds) await alertRow(id, 'u1', stock, thr, at);
    // the state the canonical-key migration leaves behind: keys built by PostgreSQL from the unquantised value
    await db.$executeRawUnsafe(
      `UPDATE "Alert" SET "activeKey" = "userId" || ':' || "stockId" || ':' || "type"::text || ':' || trim_scale(round("threshold"::numeric, 6))::text || ':' || COALESCE("chatId"::text, '') WHERE "status"='ACTIVE'`,
    );

    deploy(QUANTIZED_THRESHOLDS);

    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        status: string;
        activeKey: string | null;
        userId: string;
        stockId: string;
        threshold: number;
        chatId: bigint | null;
      }>
    >(
      `SELECT "id","status"::text AS status,"activeKey","userId","stockId","threshold","chatId" FROM "Alert"`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(7); // nothing deleted
    expect(by.c8).toMatchObject({ status: 'DISABLED', activeKey: null });
    expect(by.c1.threshold).toBe(0.123457);
    expect(by.c2.threshold).toBe(4.000001);
    expect(by.c5.threshold).toBe(0.123456);
    expect(by.c7).toMatchObject({ status: 'DISABLED', activeKey: null });
    for (const r of rows.filter((x) => x.status === 'ACTIVE')) {
      expect(r.activeKey).toBe(
        activeKeyOf({
          userId: r.userId,
          stockId: r.stockId,
          type: 'PRICE_ABOVE',
          threshold: r.threshold,
          chatId: r.chatId,
        }),
      );
    }
    expect(
      rows
        .filter((x) => x.status === 'ACTIVE')
        .map((x) => x.id)
        .sort(),
    ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  }, 180_000);
});
