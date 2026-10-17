import request from 'supertest';
import { createTestApp, TestApp } from '../setup/test-app';

/** Liveness/readiness probes and the metrics histograms through real HTTP. */
describe('probes (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('GET /live answers without touching any dependency', async () => {
    const res = await http().get('/live').expect(200);
    expect(res.body).toMatchObject({ alive: true });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.eventLoopDelayP99Ms).toBe('number');
    expect(res.body.memoryRssMb).toBeGreaterThan(0);
  });

  it('GET /ready is 200 with every migration applied, and reports what it checked', async () => {
    const res = await http().get('/ready').expect(200);
    expect(res.body).toMatchObject({
      ready: true,
      checks: { database: 'ok', migrations: 'ok' },
      pendingMigrations: [],
    });
    expect(['disabled', 'ok']).toContain(res.body.checks.redis);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres(ql)?:\/\//i); // never a connection string
  });

  it('GET /metrics exposes request histograms without any user id', async () => {
    await t.app
      .get((await import('../../src/chat/chat.service')).ChatService)
      .handle({ telegramId: 424242, chatId: 424242, chatType: 'private', text: 'TSTA' });
    const res = await http().get('/metrics').expect(200);
    expect(res.text).toMatch(/chat_requests_total\{intent="STOCK_QUOTE",status="ok"\} \d+/);
    expect(res.text).toMatch(/chat_latency_ms_bucket\{intent="STOCK_QUOTE",le="\+Inf"\} \d+/);
    expect(res.text).not.toContain('424242');
  });
});
