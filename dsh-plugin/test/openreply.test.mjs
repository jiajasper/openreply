/**
 * Host-half regression for @local/dsh-openreply with a fake DSH Host: routes register and
 * unregister with the plugin, status reads PM2 / health / public URL, PM2 is never asked when
 * its daemon is down, logs are limited to logs/*.log, secrets are masked, and table names
 * outside the catalog are refused.
 *   node --test --test-force-exit dsh-plugin/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { OpenReplyStatus, envValue, isSecretColumn, maskRow, tailLines } = await import('../index.js');

const root = mkdtempSync(join(tmpdir(), 'dsh-openreply-'));
const repo = join(root, 'openreply');
mkdirSync(join(repo, 'logs'), { recursive: true });
writeFileSync(join(repo, 'logs', 'worker-out.log'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
writeFileSync(join(repo, 'logs', 'notes.txt'), 'not a log');

const fakePm2 = join(root, 'pm2');
writeFileSync(fakePm2, `#!/bin/sh
echo '[{"name":"openreply-web","pid":42,"pm2_env":{"status":"online","pm_uptime":${Date.now() - 60000},"restart_time":1},"monit":{"cpu":3,"memory":104857600}}]'
`);
chmodSync(fakePm2, 0o755);
const pm2Home = join(root, 'pm2home');
mkdirSync(pm2Home);

const health = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', checks: { database: { status: 'ok' }, redis: { status: 'ok' }, queue: { counts: { waiting: 0, active: 0, delayed: 0, failed: 0 } }, worker: { healthy: true, ageMs: 1000 } } }));
});
await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${health.address().port}`;
writeFileSync(join(repo, '.env'), `DATABASE_URL=postgresql://nobody@127.0.0.1:1/none\nNEXTAUTH_URL="${base}/"\nSECRET=do-not-read\n`);

function fakeCtx() {
  const routes = new Map();
  const effects = [];
  return {
    routes,
    effects,
    logger: () => ({ warn() {}, info() {} }),
    connection: {
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
    },
    effect(fn) { effects.push(fn()); },
  };
}

const plugin = (ctx, extra = {}) => new OpenReplyStatus(ctx, { repo, pm2: fakePm2, pm2Home, healthUrl: `${base}/api/health`, ...extra });

test.after(() => health.close());

test('helpers: env parsing, masking, tail', () => {
  assert.equal(envValue('A=1\nB="two"\n', 'B'), 'two');
  assert.equal(envValue('A=1', 'Z'), '');
  for (const name of ['accessToken', 'refresh_token', 'sessionToken', 'tokenHash', 'apiKey', 'webhookSecret']) assert.ok(isSecretColumn(name), name);
  for (const name of ['tokenExpiresAt', 'token_type', 'keywords', 'matchedKeyword', 'id']) assert.ok(!isSecretColumn(name), name);
  assert.deepEqual(maskRow({ id: 1, accessToken: 'x', tokenExpiresAt: 't', note: null, apiKey: null }), { id: 1, accessToken: '••••', tokenExpiresAt: 't', note: null, apiKey: null });
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
});

test('routes register with the plugin and go away with it', () => {
  const ctx = fakeCtx();
  plugin(ctx).apply();
  assert.deepEqual([...ctx.routes.keys()].sort(), ['/api/openreply/db/table', '/api/openreply/db/tables', '/api/openreply/log', '/api/openreply/logs', '/api/openreply/status']);
  for (const dispose of ctx.effects) dispose();
  assert.equal(ctx.routes.size, 0);
});

test('PM2 is not asked while its daemon is down', async () => {
  const status = await plugin(fakeCtx()).status();
  assert.equal(status.pm2.procs.length, 0);
  assert.match(status.pm2.error, /PM2 daemon is not running/);
});

test('status reads PM2, health and the public URL', async () => {
  writeFileSync(join(pm2Home, 'pm2.pid'), String(process.pid));
  const status = await plugin(fakeCtx()).status();
  assert.equal(status.pm2.error, '');
  assert.equal(status.pm2.procs[0].name, 'openreply-web');
  assert.equal(status.pm2.procs[0].memoryMb, 100);
  assert.ok(status.pm2.procs[0].uptimeMs >= 60000);
  assert.equal(status.health.status, 'ok');
  assert.equal(status.health.checks.worker, true);
  assert.equal(status.public.url, `${base}/`);
  assert.equal(status.public.httpStatus, 200);
  assert.ok(!JSON.stringify(status).includes('do-not-read'));
  assert.ok(!JSON.stringify(status).includes('postgresql://'));
});

test('logs: only *.log files in logs/, tail of N lines', async () => {
  const p = plugin(fakeCtx());
  assert.deepEqual((await p.logFiles()).map((f) => f.name), ['worker-out.log']);
  const log = await p.log('worker-out.log', 10);
  assert.equal(log.text.split('\n').length, 10);
  assert.equal(log.text.split('\n').at(-1), 'line 50');
  await assert.rejects(p.log('../.env'), /No log file/);
  await assert.rejects(p.log('notes.txt'), /No log file/);
});

test('table: names outside the identifier pattern are refused before psql runs', async () => {
  const p = plugin(fakeCtx(), { psql: '/nonexistent/psql' });
  await assert.rejects(p.table('User"; drop table x; --'), /Invalid table name/);
});

test('the status route answers JSON through the Connection fetch contract', async () => {
  const ctx = fakeCtx();
  plugin(ctx).apply();
  const res = await ctx.routes.get('/api/openreply/log').fetch(new Request('http://x/api/openreply/log', { method: 'POST', body: JSON.stringify({ name: 'nope.log' }) }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  for (const dispose of ctx.effects) dispose();
});
