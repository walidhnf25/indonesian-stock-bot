#!/usr/bin/env node
/**
 * Compares what docker-compose.yml DECLARES with what the running containers actually HAVE.
 * A limit written in the Compose file does nothing for a container that was created before the limit was added:
 * only `docker inspect` shows what is in force. Read-only: it never starts, stops or recreates anything.
 *
 *   npm run docker:verify          (exit 0 = every declared limit is active, 1 = a mismatch, 2 = cannot check)
 */
const { execFileSync } = require('node:child_process');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let config;
try {
  config = JSON.parse(run('docker', ['compose', 'config', '--format', 'json']));
} catch (e) {
  console.error('cannot read the Compose configuration:', String(e.message).split('\n')[0]);
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const [service, def] of Object.entries(config.services ?? {})) {
  const name = def.container_name;
  if (!name) continue;
  let inspect;
  try {
    inspect = JSON.parse(run('docker', ['inspect', name]))[0];
  } catch {
    rows.push({ service, name, check: 'container', declared: 'exists', active: 'NOT FOUND', ok: false });
    failed++;
    continue;
  }
  const host = inspect.HostConfig;
  const wantMem = def.mem_limit ? Number(def.mem_limit) : 0;
  const wantNano = def.cpus ? Math.round(Number(def.cpus) * 1e9) : 0;
  const checks = [
    ['memory (bytes)', wantMem, host.Memory],
    ['cpus (nano)', wantNano, host.NanoCpus],
    ['restart policy', def.restart ?? 'no', host.RestartPolicy?.Name || 'no'],
  ];
  for (const [check, declared, active] of checks) {
    const ok = String(declared) === String(active);
    if (!ok) failed++;
    rows.push({ service, name, check, declared: String(declared), active: String(active), ok });
  }
  const health = inspect.State?.Health?.Status ?? inspect.State?.Status;
  rows.push({ service, name, check: 'state', declared: 'healthy/running', active: String(health), ok: ['healthy', 'running'].includes(health) });
  if (!['healthy', 'running'].includes(health)) failed++;
  rows.push({
    service,
    name,
    check: 'created (UTC)',
    declared: '-',
    active: `${inspect.Created} (started ${inspect.State?.StartedAt})`,
    ok: true,
  });
}

for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(20)} ${r.check.padEnd(16)} declared=${r.declared}  active=${r.active}`);
}
if (failed > 0) {
  console.error(
    `\n${failed} mismatch(es). A container created before its limits were declared keeps running without them.\n` +
      'Recreate ONLY the affected service, keeping its volume (never "down -v"):  docker compose up -d <service>',
  );
  process.exit(1);
}
console.log('\nevery declared limit is active on the running containers');
