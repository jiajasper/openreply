# @local/dsh-openreply

A **read-only** view of the OpenReply (Mixbash Auto Reply) deployment on this Mac, on the **OpenReply**
page in the DeepSeek Harness sidebar.

```text
PM2 daemon (its own process) ─┬─ openreply-web     next start :3000
                              ├─ openreply-worker  BullMQ DM worker
                              └─ cloudflared       tunnel → openreply.mixbash.com
DSH ── this plugin ── asks only: pm2 jlist · GET /api/health · HEAD public URL · tail logs/*.log · psql (read-only)
```

- **Status:** each PM2 process (status, uptime, restarts, CPU, memory, PID), `/api/health` (Postgres, Redis,
  DM queue counts, worker heartbeat) and the public URL's HTTP status. Refreshes every 5 s.
- **Logs:** any `*.log` in the checkout's `logs/` folder, last 100–1000 lines, optional follow.
- **Database:** every table in `public` with its row count; 25 rows a page, newest first. Columns whose names
  hold `token`, `secret`, `apiKey` or `password` are masked on the host before they reach the page.

## It never controls anything

PM2 owns the three processes. The plugin starts, stops and restarts nothing, and it does not spawn a PM2
daemon (`pm2 jlist` runs only when `~/.pm2/pm2.pid` is alive). Quitting DeepSeek Harness leaves the web app,
the worker and the tunnel running. Database queries run with `default_transaction_read_only=on` and an
8 s statement timeout; table names are checked against Postgres's catalog and no caller SQL is ever run.

## Config

The checkout is found from, in order: the `openreply` row's `repo`, `$OPENREPLY_REPO`,
`~/.dsh/openreply/repo-root`, then `~/Documents/GitHub/openreply`. `DATABASE_URL` and `NEXTAUTH_URL` (the
public URL) are read from that checkout's `.env` per request; nothing from it is returned to the page.
Optional row config: `pm2`, `psql` (paths; default Homebrew), `healthUrl` (default
`http://127.0.0.1:3000/api/health`), `pm2Home`.

## Routes (owner-only, read-only)

`GET /api/openreply/status` · `GET /api/openreply/logs` · `POST /api/openreply/log {name, lines}` ·
`GET /api/openreply/db/tables` · `POST /api/openreply/db/table {name, page}`

## Tests

```bash
node --test --test-force-exit dsh-plugin/test/*.test.mjs
```
