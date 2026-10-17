#!/usr/bin/env node
/**
 * Security mutation harness. For each guard it removes ONE protection from a private COPY of the working tree
 * and runs the tests that are supposed to fail. A mutant that does not make them fail "survives": the guard could be
 * deleted without the suite noticing.
 *
 *   node scripts/security-mutations.js                # all mutants
 *   node scripts/security-mutations.js R01,M02,R17    # some
 *   KEEP_COPY=1 node scripts/security-mutations.js    # leave the copy for inspection
 *
 * Safety: the repository itself is never modified (the copy lives in the OS temp directory; node_modules is shared by a
 * directory junction/symlink that is removed BEFORE the copy is deleted). The tests use the isolated `ai_stock_test`
 * database; the Redis-mode detectors use database 2 with the `stockbottest:` prefix (docker compose Redis on :6380).
 * Run it serially, with nothing else using the test database. Known limits: it samples guards, it is not an
 * exhaustive mutation tester; a mutant that makes a test run forever is cut off by the per-command timeout only
 * (child processes of a timed-out shell may need to be killed by hand).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const REDIS_ENV = { REDIS_URL: process.env.MUTATION_REDIS_URL ?? 'redis://127.0.0.1:6380/2', REDIS_KEY_PREFIX: 'stockbottest:' };
const TIMEOUT_MS = 600_000;

const INT = (...f) => ({ cmd: `npx jest --config ./test/jest-integration.json --runInBand ${f.map((x) => 'test/integration/' + x).join(' ')}` });
const INTR = (...f) => ({ ...INT(...f), env: REDIS_ENV });
const UNIT = (...f) => ({ cmd: `npx jest ${f.join(' ')}` });
const NEVER = 'Date.now() < 0'; // a guard that is never true but keeps TypeScript narrowing intact

const SCHED_TESTS = ['src/stock/governance/provider-scheduler.spec.ts', 'src/stock/governance/scheduler-rate.spec.ts'];
const GOV = 'src/stock/governance/market-data-governor.ts';
const SCHED = 'src/stock/governance/provider-scheduler.ts';
const PAYLOAD = 'src/notifier/notification-payload.ts';
const NOTIFIER = 'src/notifier/notifier.service.ts';
const BOUNDED = 'src/common/utils/bounded-http.ts';
const ALERTS = 'src/alert/alert.service.ts';

/** { id, area, what, file, edits: [[exact text, replacement]], detect: [{cmd, env?}] } */
const MUTANTS = [
  { id: 'R01', area: 'budget', what: 'no system reserve (one shared pool again)', file: GOV, edits: [['return Math.min(this.limits.systemReservePerHour, this.limits.globalPerHour);', 'return 0;']], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts'), INT('market-data-reserve.spec.ts')] },
  { id: 'R02', area: 'budget', what: 'users may spend the whole ceiling (reserve not carved out)', file: GOV, edits: [['return this.limits.globalPerHour - this.systemReserve;', 'return this.limits.globalPerHour;']], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts'), INT('market-data-reserve.spec.ts')] },
  { id: 'R03', area: 'budget', what: 'system callers bypass their reserve', file: GOV, edits: [["    if (r.allowed) return null;\n    return this.refuse(\n      'system_reserve'", "    if (r.allowed || true) return null;\n    return this.refuse(\n      'system_reserve'"]], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts')] },
  { id: 'R04', area: 'budget', what: 'per-user hourly quota effectively off', file: GOV, edits: [["this.take('userhour', caller, this.limits.userPerHour, HOUR_MS)", "this.take('userhour', caller, this.limits.userPerHour * 1000000, HOUR_MS)"]], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts')] },
  { id: 'R05', area: 'budget', what: 'process-local floor removed (Redis state loss refills the budget)', file: GOV, edits: [['this.floor = this.quota instanceof InMemoryQuotaStore ? null : new InMemoryQuotaStore();', 'this.floor = null;']], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts'), INTR('redis.spec.ts')] },
  { id: 'R06', area: 'budget', what: 'scheduler serves users before system callers', file: SCHED, edits: [['return this.takeFrom(this.rotationPrivileged) ?? this.takeFrom(this.rotation);', 'return this.takeFrom(this.rotation) ?? this.takeFrom(this.rotationPrivileged);']], detect: [UNIT(...SCHED_TESTS)] },
  { id: 'R07', area: 'budget', what: 'system jobs take the users\' waiting room (shared queue bound)', file: SCHED, edits: [['          : this.queued - this.queuedPrivileged >= this.opts.queueGlobal', '          : this.queued >= this.opts.queueGlobal']], detect: [UNIT(...SCHED_TESTS)] },
  { id: 'R08', area: 'budget', what: 'system waiting room unbounded', file: SCHED, edits: [['? this.queuedPrivileged >= queueSystem', '? this.queuedPrivileged >= queueSystem * 1000000']], detect: [UNIT(...SCHED_TESTS)] },
  { id: 'R09', area: 'budget', what: 'user pool check effectively off', file: GOV, edits: [["const g = await this.take('global', provider, limit, HOUR_MS);", "const g = await this.take('global', provider, limit * 1000000, HOUR_MS);"]], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts', 'src/stock/governance/governor.spec.ts'), INT('market-data-reserve.spec.ts')] },
  { id: 'R26', area: 'budget', what: 'invalid/missing limits no longer refused', file: GOV, edits: [['    assertValidLimits(this.limits);\n', '']], detect: [UNIT('src/stock/governance/budget-reserve.spec.ts')] },
  { id: 'R10', area: 'notifications', what: 'payload validation disabled', file: PAYLOAD, edits: [['export function parseNotification(data: unknown): ParsedNotification {', 'export function parseNotification(data: unknown): ParsedNotification {\n  if (data !== undefined) return { ok: true, value: data as Notification };']], detect: [UNIT('src/notifier'), INTR('notification-queue.spec.ts')] },
  { id: 'R11', area: 'notifications', what: 'recipient check removed', file: NOTIFIER, edits: [['if (refusal) return this.reject(job, refusal);', `if (refusal && ${NEVER}) return this.reject(job, refusal);`]], detect: [INTR('notification-queue.spec.ts')] },
  { id: 'R12', area: 'notifications', what: 'rejected job is retried (UnrecoverableError -> Error)', file: NOTIFIER, edits: [['throw new UnrecoverableError(', 'throw new Error(']], detect: [INTR('notification-queue.spec.ts')] },
  { id: 'R13', area: 'notifications', what: 'markup validation skipped', file: PAYLOAD, edits: [['if (markup) return { ok: false, reason: markup };', `if (markup && ${NEVER}) return { ok: false, reason: markup };`]], detect: [UNIT('src/notifier'), INTR('notification-queue.spec.ts')] },
  { id: 'R14', area: 'notifications', what: 'length limit skipped', file: PAYLOAD, edits: [['if (html.length > MAX_NOTIFICATION_HTML_CHARS) return', `if (html.length > MAX_NOTIFICATION_HTML_CHARS && ${NEVER}) return`]], detect: [UNIT('src/notifier'), INTR('notification-queue.spec.ts')] },
  { id: 'R15', area: 'notifications', what: 'unexpected fields tolerated', file: PAYLOAD, edits: [["if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {", `if ((typeof key !== 'string' || !ALLOWED_KEYS.has(key)) && ${NEVER}) {`]], detect: [UNIT('src/notifier'), INTR('notification-queue.spec.ts')] },
  { id: 'R16', area: 'notifications', what: 'payload of a rejected job stays in Redis', file: NOTIFIER, edits: [['await job.updateData({ rejected: reason }).catch(() => undefined);', '']], detect: [INTR('notification-queue.spec.ts')] },
  { id: 'R27', area: 'notifications', what: 'links allowed in queued notices', file: PAYLOAD, edits: [['validateTelegramHtml(html, { allowLinks: false })', 'validateTelegramHtml(html, { allowLinks: true })']], detect: [UNIT('src/notifier'), INTR('notification-queue.spec.ts')] },
  { id: 'R17', area: 'responses', what: 'byte counting removed from the bounded reader', file: BOUNDED, edits: [['      if (total > maxBytes) {\n        await reader.cancel()', `      if (total > maxBytes && ${NEVER}) {\n        await reader.cancel()`]], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R18', area: 'responses', what: 'postJson reads with res.json() again', file: 'src/ai/providers/http.ts', edits: [['return await readJsonBounded(res, maxBytes);', 'return await res.json();']], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R19', area: 'responses', what: 'no default ceiling for postJson', file: 'src/ai/providers/http.ts', edits: [['const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;', 'const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER;']], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R20', area: 'responses', what: 'boundedFetch loses its deadline', file: BOUNDED, edits: [['const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;', 'const signal = init?.signal ?? undefined;']], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R21', area: 'responses', what: 'boundedFetch stops counting streamed bytes (the test may exhaust memory: that IS the detection)', file: BOUNDED, edits: [['          if (total > opts.maxBytes) {', `          if (total > opts.maxBytes && ${NEVER}) {`]], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R22', area: 'responses', what: 'embedding response read with res.json()', file: 'src/rag/embedding.provider.ts', edits: [['body = (await readJsonBounded(\n        res,\n        this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,\n      )) as { embeddings?: unknown };', 'body = (await res.json()) as { embeddings?: unknown };']], detect: [UNIT('src/common/utils/bounded-http.spec.ts')] },
  { id: 'R23', area: 'alerts', what: 'reactivate() counts ACTIVE only again', file: ALERTS, edits: [['if ((await this.countLive(tx, alert.userId)) >= MAX_ACTIVE_ALERTS) {', "if ((await tx.alert.count({ where: { userId: alert.userId, status: 'ACTIVE' } })) >= MAX_ACTIVE_ALERTS) {"]], detect: [INT('alert-cap.spec.ts')] },
  { id: 'R24', area: 'alerts', what: 'create() counts ACTIVE only', file: ALERTS, edits: [['if ((await this.countLive(tx, userId)) >= MAX_ACTIVE_ALERTS) {', "if ((await tx.alert.count({ where: { userId, status: 'ACTIVE' } })) >= MAX_ACTIVE_ALERTS) {"]], detect: [INT('alert-cap.spec.ts', 'watchlist-alert.spec.ts', 'scoping-and-races.spec.ts')] },
  { id: 'R25', area: 'alerts', what: 'reactivate() loses the per-user advisory lock', file: ALERTS, edits: [['          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${alert.userId}, 0))`;\n          const current = await tx.alert.findFirst(back);', '          const current = await tx.alert.findFirst(back);']], detect: [INT('alert-cap.spec.ts', 'scoping-and-races.spec.ts')] },
  { id: 'M02', area: 'isolation', what: 'portfolio history() loses its user scope', file: 'src/portfolio/portfolio.service.ts', edits: [['async history(userId: string, limit = 10): Promise<LedgerRow[]> {\n    const portfolio = await this.prisma.portfolio.findUnique({\n      where: { userId_name: { userId, name: DEFAULT_NAME } },', 'async history(userId: string, limit = 10): Promise<LedgerRow[]> {\n    const portfolio = await this.prisma.portfolio.findFirst({\n      where: {},']], detect: [INT('portfolio-isolation.spec.ts')] },
  { id: 'M02b', area: 'isolation', what: 'history() ledger query loses the portfolio filter', file: 'src/portfolio/portfolio.service.ts', edits: [["      where: { portfolioId: portfolio.id },\n      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],\n      take: Math.min(50, Math.max(1, limit)),", "      where: {},\n      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],\n      take: Math.min(50, Math.max(1, limit)),"]], detect: [INT('portfolio-isolation.spec.ts')] },
  { id: 'M25', area: 'isolation', what: 'breaker re-check inside the scheduled task removed', file: GOV, edits: [['if (!this.breaker.allow()) {\n            this.metrics.inc', 'if (false) {\n            this.metrics.inc']], detect: [UNIT('src/stock/governance/breaker-guard.spec.ts')] },
  { id: 'M25b', area: 'isolation', what: 'breaker refusal at the door removed', file: GOV, edits: [['if (this.breaker.blocked()) {', 'if (false) {']], detect: [UNIT('src/stock/governance/breaker-guard.spec.ts', 'src/stock/governance/governor.spec.ts')] },
  { id: 'M25c', area: 'isolation', what: 'abandoned half-open probe never frees its slot', file: 'src/stock/governance/circuit-breaker.ts', edits: [["if (this.current === 'HALF_OPEN') this.probeInFlight = false;", '/* mutated: probe slot not freed */']], detect: [UNIT('src/stock/governance/breaker-guard.spec.ts')] },
  { id: 'M04', area: 'regression', what: 'per-user per-minute quota effectively off', file: GOV, edits: [["this.take('user', caller, this.limits.userPerMinute, 60_000)", "this.take('user', caller, this.limits.userPerMinute * 1000000, 60_000)"]], detect: [UNIT('src/stock/governance/governor.spec.ts', 'src/stock/governance/budget-reserve.spec.ts')] },
  { id: 'M09', area: 'regression', what: 'scheduler fairness broken (same caller served until its queue is empty)', file: SCHED, edits: [['if (queue.length > 0) rotation.push(caller);', 'if (queue.length > 0) rotation.unshift(caller);']], detect: [UNIT('src/stock/governance/provider-scheduler.spec.ts')] },
  { id: 'M18', area: 'regression', what: 'alert claim no longer requires status ACTIVE (double delivery)', file: ALERTS, edits: [["where: { id: alert.id, status: 'ACTIVE' },\n            data: {\n              status: 'TRIGGERED',", "where: { id: alert.id },\n            data: {\n              status: 'TRIGGERED',"]], detect: [INT('alert-safety.spec.ts', 'watchlist-alert.spec.ts', 'scoping-and-races.spec.ts')] },
];

const norm = (s) => s.replace(/\r\n/g, '\n');

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-bot-mut-'));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('docs/') && fs.existsSync(path.join(REPO, f)));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

function removeCopy(dir) {
  // the link first: removing it must never touch the real node_modules
  try {
    fs.rmdirSync(path.join(dir, 'node_modules'));
  } catch {
    fs.unlinkSync(path.join(dir, 'node_modules'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(work, { cmd, env }) {
  const r = spawnSync(cmd, { shell: true, cwd: work, env: { ...process.env, ...(env ?? {}) }, encoding: 'utf8', maxBuffer: 1 << 28, timeout: TIMEOUT_MS });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    tests: (out.match(/^Tests:.*$/gm) || []).join(' | ') || (r.error ? `no result (${r.error.code ?? r.error.message})` : 'no result'),
    failed: (out.match(/●.*›/g) || []).length,
    compileError: /Test suite failed to run|error TS\d+/.test(out),
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

const work = makeCopy();
const results = [];
try {
  for (const m of MUTANTS) {
    if (only && !only.has(m.id)) continue;
    const target = path.join(work, m.file);
    const original = norm(fs.readFileSync(path.join(REPO, m.file), 'utf8'));
    let mutated = original;
    let problem = null;
    for (const [from, to] of m.edits) {
      const n = mutated.split(from).length - 1;
      if (n !== 1) {
        problem = `anchor occurs ${n}x: ${from.slice(0, 60)}`;
        break;
      }
      mutated = mutated.replace(from, () => to);
    }
    if (problem) {
      results.push({ id: m.id, area: m.area, result: 'ANCHOR-ERROR', detail: problem });
      continue;
    }
    fs.writeFileSync(target, mutated);
    try {
      const runs = m.detect.map((d) => run(work, d));
      const detected = runs.some((x) => x.failed > 0 || /\d+ failed/.test(x.tests) || x.timedOut);
      const result = detected ? 'KILLED' : runs.some((x) => x.compileError) ? 'COMPILE-ERROR' : 'SURVIVED';
      results.push({ id: m.id, area: m.area, what: m.what, result, tests: runs.map((x) => x.tests).join(' || ') });
    } finally {
      fs.writeFileSync(target, original); // the copy is restored after every mutant
    }
    const last = results[results.length - 1];
    console.log(`${last.result.padEnd(14)} ${m.id.padEnd(5)} ${m.area.padEnd(8)} ${m.what}`);
  }
} finally {
  if (process.env.KEEP_COPY) console.log('copy kept at', work);
  else removeCopy(work);
}

const survived = results.filter((r) => r.result !== 'KILLED');
console.log(`\n${results.length - survived.length}/${results.length} mutants killed`);
for (const s of survived) console.log(`NOT KILLED: ${s.id} (${s.result}) ${s.what ?? ''} ${s.detail ?? ''}`);
process.exit(survived.length === 0 ? 0 : 1);
