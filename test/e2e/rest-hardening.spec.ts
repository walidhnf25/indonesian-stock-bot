import request from 'supertest';
import { createTestApp, TestApp } from '../setup/test-app';

/** the unauthenticated REST API is loopback-only at the HTTP level and bounded in what it accepts. */
describe('REST hardening (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('does not advertise the framework (no X-Powered-By)', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves a normal local request', async () => {
    await http().get('/stocks/TSTA').set('Host', 'localhost:3000').expect(200);
  });

  it.each(['example.com', 'attacker.test:3000', '192.168.1.20:3000'])(
    'refuses Host: %s with 403 (DNS rebinding / remote access)',
    async (host) => {
      const res = await http().get('/stocks/BBCA').set('Host', host).expect(403);
      expect(res.body.message).toMatch(/Host/);
      expect(JSON.stringify(res.body)).not.toMatch(/BBCA|price/i);
    },
  );

  it('refuses a cross-origin browser POST before any work (or AI quota) is spent', async () => {
    const res = await http()
      .post('/analysis/BBCA')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(res.body.message).toMatch(/Origin/);
  });

  it('accepts a local page origin', async () => {
    await http().get('/stocks/TSTA').set('Origin', 'http://localhost:5173').expect(200);
  });

  it('rejects an oversized body with a 4xx status (not a 500)', async () => {
    const res = await http()
      .post('/analysis/BBCA')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(40_000) }));
    expect(res.status).toBe(413);
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const res = await http()
      .post('/analysis/BBCA')
      .set('Content-Type', 'application/json')
      .send('{"a": ');
    expect(res.status).toBe(400);
  });

  it('applies the per-caller AI budget to POST /analysis/:symbol (429 after the limit)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await http().post('/analysis/BBCA')).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 2)).not.toContain(429);
  });
});
