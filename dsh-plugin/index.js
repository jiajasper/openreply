/**
 * Host half of @local/dsh-openreply: a READ-ONLY window onto the OpenReply deployment.
 *
 *   PM2 (its own daemon) ─┬─ openreply-web     (next start, :3000)
 *                         ├─ openreply-worker  (BullMQ DM worker)
 *                         └─ cloudflared       (tunnel → openreply.mixbash.com)
 *
 * This plugin owns none of those processes. It only asks: `pm2 jlist` (and only when the
 * PM2 daemon is already running, so it never spawns one), HTTP GETs of /api/health and the
 * public URL, the tail of the PM2 log files, and `psql` inside a read-only transaction.
 * Nothing here starts, stops or restarts anything, so quitting DeepSeek Harness leaves
 * the web app, the worker and the tunnel running.
 *
 * Every route is owner-only (DSH's Connection Fetch routes refuse non-owner peers) and runs
 * fixed executables with fixed arguments, never a shell. Table names come from Postgres's
 * own catalog and are checked against it; no caller SQL is ever run. Columns that hold
 * tokens, secrets or keys are masked before they leave the host.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const inject = ['connection'];

const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh');
const PM2_HOME = process.env.PM2_HOME || join(HOME, '.pm2');
const PM2_CANDIDATES = ['/opt/homebrew/bin/pm2', '/usr/local/bin/pm2'];
const PSQL_CANDIDATES = ['/opt/homebrew/bin/psql', '/opt/homebrew/opt/postgresql@17/bin/psql', '/opt/homebrew/opt/postgresql@16/bin/psql', '/usr/local/bin/psql'];
// pm2 is a node script: give it Node 22 (Prisma's supported line) and Homebrew whatever
// PATH the desktop app was launched with.
const CHILD_PATH = ['/opt/homebrew/opt/node@22/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_LOG_LINES = 1000;
const PAGE_SIZE = 25;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Column names whose values never leave the host. Keeps *ExpiresAt / token_type visible.
const SECRET_COLUMN_RE = /(token|secret|apikey|api_key|password|passwd|private_?key)/i;
const SECRET_COLUMN_ALLOW_RE = /(expires|_type$|type$)/i;

export function isSecretColumn(name) {
  return SECRET_COLUMN_RE.test(name) && !SECRET_COLUMN_ALLOW_RE.test(name);
}

export function maskRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row ?? {})) out[key] = value != null && isSecretColumn(key) ? '••••' : value;
  return out;
}

/** One `KEY=value` from a dotenv file, without loading (or returning) the rest of it. */
export function envValue(text, key) {
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return '';
}

export function tailLines(text, lines) {
  const all = String(text).split('\n');
  if (all.at(-1) === '') all.pop();
  return all.slice(-lines).join('\n');
}

function firstExisting(list) {
  return list.find((path) => existsSync(path)) ?? '';
}

/** The openreply checkout: config, $OPENREPLY_REPO, ~/.dsh/openreply/repo-root, then the usual place. */
function resolveRepo(configured) {
  if (configured) return configured;
  if (process.env.OPENREPLY_REPO) return process.env.OPENREPLY_REPO;
  try {
    const fromFile = readFileSync(join(DSH_HOME, 'openreply', 'repo-root'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* none */ }
  return join(HOME, 'Documents', 'GitHub', 'openreply');
}

export class OpenReplyStatus {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    const given = Object.fromEntries(Object.entries(config ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    this.repo = resolveRepo(given.repo);
    this.pm2 = given.pm2 || firstExisting(PM2_CANDIDATES);
    this.psql = given.psql || firstExisting(PSQL_CANDIDATES);
    this.healthUrl = given.healthUrl || 'http://127.0.0.1:3000/api/health';
    this.pm2Home = given.pm2Home || PM2_HOME;
    this.logger = ctx.logger?.('dsh-openreply') ?? console;
  }

  get logsDir() {
    return join(this.repo, 'logs');
  }

  /** DATABASE_URL and NEXTAUTH_URL from the checkout's .env, read per call (it can change). */
  env() {
    try {
      const text = readFileSync(join(this.repo, '.env'), 'utf8');
      return { databaseUrl: envValue(text, 'DATABASE_URL'), publicUrl: envValue(text, 'NEXTAUTH_URL') };
    } catch {
      return { databaseUrl: '', publicUrl: '' };
    }
  }

  exec(file, args, { timeout = 10000, env = {} } = {}) {
    return new Promise((resolve) => {
      execFile(file, args, {
        cwd: existsSync(this.repo) ? this.repo : HOME,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: CHILD_PATH, ...env },
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error ? error.message : '') });
      });
    });
  }

  /** True only when a PM2 daemon is already up; `pm2 jlist` would otherwise launch one. */
  pm2DaemonRunning() {
    try {
      const pid = Number(readFileSync(join(this.pm2Home, 'pm2.pid'), 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  async processes() {
    if (!this.pm2) return { procs: [], error: 'pm2 is not installed (npm install -g pm2).' };
    if (!this.pm2DaemonRunning()) return { procs: [], error: 'The PM2 daemon is not running. Start it from the openreply checkout: pm2 resurrect (or pm2 start ecosystem.config.js).' };
    const out = await this.exec(this.pm2, ['jlist']);
    try {
      const list = JSON.parse(out.stdout.slice(out.stdout.indexOf('[')));
      const now = Date.now();
      return {
        procs: list.map((p) => ({
          name: String(p.name),
          status: String(p.pm2_env?.status ?? 'unknown'),
          pid: Number(p.pid ?? 0),
          uptimeMs: p.pm2_env?.status === 'online' && p.pm2_env?.pm_uptime ? now - Number(p.pm2_env.pm_uptime) : 0,
          restarts: Number(p.pm2_env?.restart_time ?? 0),
          cpu: Number(p.monit?.cpu ?? 0),
          memoryMb: Math.round(Number(p.monit?.memory ?? 0) / 1048576),
        })),
        error: '',
      };
    } catch {
      return { procs: [], error: (out.stderr || out.stdout || 'pm2 did not answer').slice(0, 400) };
    }
  }

  async health() {
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(5000) });
      const body = await res.json().catch(() => null);
      return {
        reachable: true,
        httpStatus: res.status,
        status: String(body?.status ?? `HTTP ${res.status}`),
        checks: {
          database: body?.checks?.database?.status ?? 'unknown',
          redis: body?.checks?.redis?.status ?? 'unknown',
          queue: body?.checks?.queue?.counts ?? null,
          worker: Boolean(body?.checks?.worker?.healthy),
          workerAgeMs: body?.checks?.worker?.ageMs ?? null,
        },
      };
    } catch (error) {
      return { reachable: false, httpStatus: 0, status: 'unreachable', error: error instanceof Error ? error.message : String(error), checks: null };
    }
  }

  async publicCheck(url) {
    if (!url) return { url: '', httpStatus: 0, error: 'NEXTAUTH_URL is not set in .env' };
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      return { url, httpStatus: res.status, error: '' };
    } catch (error) {
      return { url, httpStatus: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status() {
    const { publicUrl } = this.env();
    const [pm2, health, pub] = await Promise.all([this.processes(), this.health(), this.publicCheck(publicUrl)]);
    return { repo: this.repo, repoFound: existsSync(this.repo), pm2, health, public: pub, checkedAt: Date.now() };
  }

  async logFiles() {
    try {
      const names = (await readdir(this.logsDir)).filter((name) => name.endsWith('.log')).sort();
      return Promise.all(names.map(async (name) => {
        const info = await stat(join(this.logsDir, name)).catch(() => null);
        return { name, size: info?.size ?? 0, modifiedAt: info?.mtimeMs ?? 0 };
      }));
    } catch {
      return [];
    }
  }

  async log(name, lines = 200) {
    const files = await this.logFiles();
    if (!files.some((file) => file.name === name)) throw new Error(`No log file named ${JSON.stringify(String(name))} in ${this.logsDir}.`);
    const count = Math.min(Math.max(Number(lines) || 200, 10), MAX_LOG_LINES);
    const path = join(this.logsDir, name);
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return { name, size, text: tailLines(buffer.toString('utf8'), count) };
    } finally {
      await handle.close();
    }
  }

  async query(sql) {
    const { databaseUrl } = this.env();
    if (!databaseUrl) throw new Error(`DATABASE_URL is not set in ${join(this.repo, '.env')}.`);
    if (!this.psql) throw new Error('psql is not installed (brew install postgresql@17).');
    const out = await this.exec(this.psql, [databaseUrl, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=8000' },
    });
    if (!out.ok) throw new Error(out.stderr.replace(/postgres(ql)?:\/\/\S+/gi, '<database>').trim().slice(0, 400) || 'psql failed');
    return out.stdout.split('\n').filter((line) => line.length > 0);
  }

  async tables() {
    const rows = await this.query(
      "select json_build_object('name', c.relname, 'rows', coalesce(s.n_live_tup, 0)) from pg_class c " +
      "join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid " +
      "where n.nspname = 'public' and c.relkind = 'r' order by c.relname",
    );
    return rows.map((line) => JSON.parse(line));
  }

  async columns(table) {
    const rows = await this.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = '${table}' order by ordinal_position`,
    );
    return rows;
  }

  async table(name, page = 0) {
    const table = String(name ?? '');
    if (!IDENT_RE.test(table)) throw new Error('Invalid table name.');
    const known = await this.tables();
    const entry = known.find((t) => t.name === table);
    if (!entry) throw new Error(`No table ${JSON.stringify(table)}.`);
    const columns = await this.columns(table);
    const offset = Math.max(0, Math.floor(Number(page) || 0)) * PAGE_SIZE;
    const order = columns.includes('createdAt') ? ' order by "createdAt" desc' : columns.includes('id') ? ' order by "id" desc' : '';
    const [{ count }] = (await this.query(`select json_build_object('count', count(*)) from "${table}"`)).map((line) => JSON.parse(line));
    const rows = (await this.query(
      `select row_to_json(t) from (select * from "${table}"${order} limit ${PAGE_SIZE} offset ${offset}) t`,
    )).map((line) => maskRow(JSON.parse(line)));
    return {
      name: table,
      columns,
      masked: columns.filter(isSecretColumn),
      rows,
      total: Number(count),
      page: offset / PAGE_SIZE,
      pageSize: PAGE_SIZE,
    };
  }

  registerRoutes() {
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
    const route = (path, methods, handler) => {
      const dispose = this.ctx.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return json({ ok: true, ...(await handler(request)) });
          } catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
          }
        },
      });
      return () => { try { dispose?.(); } catch { /* already gone */ } };
    };
    const body = async (request) => { try { return await request.json(); } catch { return {}; } };
    this.ctx.effect(() => {
      const offs = [
        route('/api/openreply/status', ['GET'], async () => ({ status: await this.status() })),
        route('/api/openreply/logs', ['GET'], async () => ({ files: await this.logFiles() })),
        route('/api/openreply/log', ['POST'], async (request) => {
          const input = await body(request);
          return { log: await this.log(input.name, input.lines) };
        }),
        route('/api/openreply/db/tables', ['GET'], async () => ({ tables: await this.tables() })),
        route('/api/openreply/db/table', ['POST'], async (request) => {
          const input = await body(request);
          return { table: await this.table(input.name, input.page) };
        }),
      ];
      return () => { for (const off of offs) off(); };
    }, 'dsh-openreply: routes');
  }

  apply() {
    this.registerRoutes();
  }
}

export function apply(ctx, config) {
  new OpenReplyStatus(ctx, config).apply();
}
