# OpenReply — Self-Hosted Deployment Guide

Operating manual for deploying [OpenReply](https://github.com/diwenne/openreply) on a
single Mac (Phase 1) or as a hybrid with Render hosting the web tier (Phase 2).

**This document is written to be handed to an AI agent.** It encodes decisions, dead ends,
and real failure modes discovered while deploying, so the agent can reproduce a working
setup without rediscovering them. Follow phases in order. Do not skip Phase 0 — most
Phase 1 failures trace back to incomplete Phase 0 credentials.

Two conventions used throughout:

- `⚠️ SPECIAL NOTE` blocks are traps that caused real failures during the original
  deployment. They are not theoretical. Read every one.
- Commands marked `# run as the human` require a password or a browser and cannot be
  automated. Ask the human to run them rather than trying.

---

## Table of Contents

- [Architecture](#architecture)
- [Phase 0 — Accounts, credentials, prerequisites](#phase-0--accounts-credentials-prerequisites)
  - [0.1 Homebrew and local services](#01-homebrew-and-local-services)
  - [0.2 Meta / Instagram developer app](#02-meta--instagram-developer-app)
  - [0.3 Resend](#03-resend)
  - [0.4 Cloudflare account and tunnel](#04-cloudflare-account-and-tunnel)
  - [0.5 Generate secrets](#05-generate-secrets)
- [Phase 1 — Full Mac deployment](#phase-1--full-mac-deployment)
  - [1.1 Clone and install](#11-clone-and-install)
  - [1.2 Create the .env](#12-create-the-env)
  - [1.3 Code changes: move crons into the worker](#13-code-changes-move-crons-into-the-worker)
  - [1.4 PM2 process manager](#14-pm2-process-manager)
  - [1.5 Prevent the machine from sleeping](#15-prevent-the-machine-from-sleeping)
  - [1.6 Survive reboot and network loss](#16-survive-reboot-and-network-loss)
  - [1.7 Verification](#17-verification)
- [Phase 2 — Optional: hybrid Render + Mac worker](#phase-2--optional-hybrid-render--mac-worker)
- [Special notes and pitfalls](#special-notes-and-pitfalls)
- [Troubleshooting](#troubleshooting)
- [Operations reference](#operations-reference)

---

## Architecture

**Phase 1 — everything on the Mac**

```
Internet ──> Cloudflare Tunnel ──> Next.js (localhost:3000) ──> PostgreSQL
                                              │                Redis
                                              └──> DM worker ──┘
                                                   (token refresh,
                                                    follower snapshots)
```

**Phase 2 — hybrid (optional)**

```
Internet ──> Render web service ──> Render PostgreSQL
                  │                  Render Redis
                  │
      Mac ──> DM worker (PM2) ────────┘
```

The worker stays on the Mac in both phases. It holds the comment→DM queue consumer and
the periodic jobs. Moving it off the Mac is the single biggest reason to consider Phase 2.

---

## Phase 0 — Accounts, credentials, prerequisites

Everything here must exist before Phase 1 begins.

### 0.1 Homebrew and local services

```bash
brew install node postgresql@16 redis cloudflared
brew services start postgresql@16
brew services start redis
createdb openreply
```

Verify:

```bash
brew services list          # postgresql@16 + redis show "started"
redis-cli ping              # PONG
psql "postgresql://$(whoami)@localhost:5432/openreply" -c "select 1;"
```

`brew services start` installs a launchd agent, so these survive reboot.

> ⚠️ **SPECIAL NOTE — Homebrew sandbox deadlock (macOS)**
>
> Symptom: `brew install` hangs indefinitely at `Pouring <pkg>` and never finishes.
> Even a single-binary formula with no dependencies hangs. `ps` shows
> `sandbox_operation.rb extract` asleep at 0% CPU; `brew.rb` blocks in
> `system_command.rb:462`.
>
> Cause: Homebrew wraps bottle extraction in `sandbox-exec`. In some sandboxed/agent
> environments the nested `sandbox-exec` deadlocks. Homebrew's own source acknowledges
> this in `extend/os/mac/sandbox.rb`: *"Nested `sandbox-exec` invocations hang inside an
> existing macOS sandbox."*
>
> Fix — patch `Sandbox.available?` to return `false`:
>
> ```bash
> cp /opt/homebrew/Library/Homebrew/extend/os/mac/sandbox.rb /tmp/sandbox.rb.bak
> # edit: in `def available?`, replace `File.executable?(SANDBOX_EXEC)` with `false`
> ```
>
> To revert:
> ```bash
> git -C /opt/homebrew checkout Library/Homebrew/extend/os/mac/sandbox.rb
> ```
>
> This disables sandboxing of *downloaded files* for brew. It is a real (if minor)
> security tradeoff, and **`brew upgrade` will hang again until reverted or repatched.**
> Tell the human about this before applying it.

### 0.2 Meta / Instagram developer app

At [developers.facebook.com/apps](https://developers.facebook.com/apps) create an app
(**Business** type), then add the **Instagram** product → **API setup with Instagram login**.

1. Add the messaging permissions (`instagram_business_basic`,
   `instagram_business_manage_comments`, `instagram_business_manage_messages`).
2. **App authentication** panel → leave *Native or desktop app* **OFF**; set
   *Authorize callback URL*.
3. **Configure webhooks** panel → Callback URL + Verify token (see §1.7 for values).
4. Add the Instagram account as an **Instagram Tester** and have it accept the invite.
5. Set Privacy Policy / Terms / Data Deletion URLs.
6. Publish the app.

> ⚠️ **SPECIAL NOTE — use the Instagram App ID, not the Meta App ID**
>
> This is the single most common failure. Two different credentials exist:
>
> | Credential | Where it lives | Used for |
> |---|---|---|
> | **Instagram App ID / Secret** | Instagram → API setup with Instagram login → *Set up Instagram business login* → **Business login settings** | OAuth `client_id` / `client_secret` |
> | Meta App ID / Secret | **App settings → Basic** | Facebook Login. **Not this flow.** |
>
> Symptom of using the wrong one — the consent screen shows:
> `Invalid Request: Request parameters are invalid: Invalid platform app`
>
> No callback ever fires and **no error is logged locally**, because Meta rejects the
> authorize request before reaching your app. `OperationalEvent` stays empty.
>
> Verify the fix without a browser by requesting the authorize URL and checking the
> response is a login page, not an error page (see §1.7).
>
> Do **not** confuse the App ID with the App Secret shown under *Facebook Login →
> Settings* (Client Secret) — that is a third, unrelated value.

> ⚠️ **SPECIAL NOTE — Instagram App ID section may not render**
>
> Meta dashboard bug, reported from March 2026 and ongoing since 2 July 2026: the
> *"Generate access tokens"* and *"Set up Instagram business login"* sections fail to
> render. The page's GraphQL response returns `biz_login_container: null`, so the
> frontend has nothing to draw. Section numbering jumps from "1. Add required messaging
> permissions" straight to "3. Configure webhooks". Reproduces on brand-new apps.
>
> Symptom: the webhook panel is visible, but there is nowhere to register the OAuth
> redirect URI, so you get `Invalid redirect_uri` no matter what you enter.
>
> This is server-side at Meta, not user error. Options: report it and wait, or use the
> Zernio provider instead (repo has full support — see `docs/zernio.md`), which uses a
> managed connection flow and needs none of your own Meta credentials.

> ⚠️ **SPECIAL NOTE — two different callback URLs, easy to swap**
>
> | Purpose | Path | Where registered |
> |---|---|---|
> | OAuth return (browser comes back here after consent) | `/api/instagram/callback` | *Set up Instagram business login* → Redirect URL |
> | Webhook events (Meta POSTs here) | `/api/webhook` | *Configure webhooks* → Callback URL |
>
> Putting `/api/instagram/callback` in the **webhook** Callback URL field produces
> *"The callback URL or verify token couldn't be validated"*.

> ⚠️ **SPECIAL NOTE — redirect URI trailing slash**
>
> Meta warns the dashboard may silently append a trailing slash to registered URIs.
> The app sends the URI **without** a trailing slash in both the authorize request and
> the token exchange, and both hops must be byte-identical. After saving, reopen the
> field and confirm no `/` was added. Symptom if it was:
> `Invalid redirect_uri`.

**App Review.** Not needed to run OpenReply for accounts that hold a role on the app
(admins, developers, Instagram testers). Publishing keeps you on Standard Access, which
covers only those roles. Advanced Access — required for clients who are *not* testers —
comes from App Review, which requires a registered business and business verification.
See `META_APP_REVIEW.md` in the repo for justification drafts.

### 0.3 Resend

1. resend.com → **Domains → Add Domain** → `yourdomain.com` → add the DNS records given.
2. Wait for status **verified**. Magic links fail without this, even with a valid key.
3. **API Keys** → create a key.

Note the login recipient's domain is independent of the sender's domain.

### 0.4 Cloudflare account and tunnel

The tunnel gives Meta a stable public HTTPS URL. Required: webhooks and OAuth need a
public origin.

```bash
cloudflared tunnel login          # run as the human; opens a browser
cloudflared tunnel create openreply
```

Record the tunnel UUID. Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<user>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: app.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Then create the DNS record — this is what makes the hostname resolve:

```bash
cloudflared tunnel route dns openreply app.yourdomain.com
```

Verify with `dig +short app.yourdomain.com` (expect Cloudflare edge IPs).

> ⚠️ **SPECIAL NOTE — `<TUNNEL-UUID>.cfargotunnel.com` does not work**
>
> Older guides tell you to use `https://<UUID>.cfargotunnel.com`. That hostname has no
> DNS record and does not resolve — confirmed against public resolvers. A named tunnel
> only gets a public hostname via `route dns` or the dashboard's *Public Hostname*. Use
> your own domain.

### 0.5 Generate secrets

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 32   # CRON_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY  (must be 64 hex chars)
openssl rand -hex 16      # WEBHOOK_VERIFY_TOKEN
```

> ⚠️ **SPECIAL NOTE — `ENCRYPTION_KEY` is permanent**
>
> Instagram tokens are encrypted at rest with it (AES-256-GCM). Changing or losing it
> makes every connected account require reconnection. In Phase 2 it must be
> **byte-identical** on Render and on the Mac — the web app encrypts, the worker
> decrypts. Copy it; never regenerate it per environment.

---

## Phase 1 — Full Mac deployment

### 1.1 Clone and install

```bash
git clone https://github.com/diwenne/openreply.git ~/Documents/openreply
cd ~/Documents/openreply
npm install
npm run db:generate
npm run db:migrate
```

`db:generate` must succeed before anything else. `db:migrate` prints
*"All migrations have been successfully applied."*

> ⚠️ **SPECIAL NOTE — `dotenv` is not declared but is imported**
>
> `prisma.config.ts` line 1 is `import "dotenv/config"`, yet `dotenv` is absent from
> `package.json`. It resolves only as a hoisted transitive dependency
> (`prisma → @prisma/config → c12 → dotenv`). If npm ever stops hoisting it,
> `db:generate`/`db:migrate` break with an opaque module-not-found error.
>
> Fix: `npm install --save-dev dotenv`.

### 1.2 Create the .env

```bash
cd ~/Documents/openreply
umask 077 && nano .env
chmod 600 .env
```

```env
# App
NEXTAUTH_URL=https://app.yourdomain.com
NEXTAUTH_SECRET=<generated>
CRON_SECRET=<generated>
ENCRYPTION_KEY=<64 hex chars>

# Database / queue
DATABASE_URL=postgresql://<macuser>@localhost:5432/openreply
REDIS_URL=redis://localhost:6379

# Email magic links (Resend)
RESEND_API_KEY=re_...
EMAIL_FROM=OpenReply <noreply@yourdomain.com>

# Sign-in allowlist. Comma-separated. Strongly recommended on a public URL.
ALLOWED_EMAILS=owner@example.com,client@example.com

# Meta / Instagram
META_GRAPH_API_VERSION=v25.0
INSTAGRAM_APP_ID=<Instagram App ID — see §0.2>
INSTAGRAM_APP_SECRET=<Instagram App Secret>
FACEBOOK_APP_SECRET=<same value; optional, webhook fallback only>
WEBHOOK_VERIFY_TOKEN=<generated>
```

`EMAIL_FROM` must be a **full address on a Resend-verified domain**. A bare domain is
rejected by Resend. The local part is arbitrary (`noreply@`, `hello@`, …).

`FACEBOOK_APP_SECRET` is optional. `lib/meta/webhook.ts` accepts a signature matching
*either* secret, so a correct `INSTAGRAM_APP_SECRET` alone suffices. Setting it to the
same value is harmless and adds redundancy.

> ⚠️ **SPECIAL NOTE — `ALLOWED_EMAILS` fails OPEN**
>
> Unset or empty means **anyone who reaches your public URL can sign in and provision a
> workspace** on your database. The instance is internet-reachable through the tunnel.
> Always set it. Verified behaviour: with it set, only listed addresses pass
> (case-insensitive); a non-listed address gets `AccessDenied` and no email is sent.
>
> Keep the placeholder-safety in mind: a literal `REPLACE_ME` value fails *closed*,
> which is safe but locks everyone out.

> ⚠️ **SPECIAL NOTE — the app must be restarted after any `.env` edit**
>
> `next start` reads `.env` once at boot. Editing the file has no effect until restart,
> and the failure is confusing rather than obvious — the app keeps serving with stale
> values and errors mention the *old* credential:
>
> ```
> [auth][error] Resend error: {"statusCode":401,"message":"API key is invalid"}
> ```
>
> That 401 once came from a placeholder key after a correct key was written but the
> process was not restarted.
>
> Always: `pm2 restart openreply-web openreply-worker && pm2 save`

### 1.3 Code changes: move crons into the worker

`vercel.json` schedules three jobs. **Nothing outside Vercel reads that file**, so on a
self-hosted instance all three silently never run. None fails loudly.

| Job | Consequence of never running |
|---|---|
| `refresh-tokens` | Instagram token expires; comments keep arriving and nothing answers them |
| `attach-next-reel` | A "next reel" campaign stays inert forever |
| `snapshot-followers` | Follower history permanently incomplete (Instagram keeps only ~30 days) |

Rather than an external scheduler, drive them from the worker process.

**Create `lib/token-refresh.ts`** — move the body of
`app/api/cron/refresh-tokens/route.ts`'s `GET` (after the auth check) into
`refreshAllTokens()`, returning a plain object instead of a `NextResponse`. Then reduce
the route to auth + `NextResponse.json({ success: true, data: await refreshAllTokens() })`.

**Create `lib/follower-snapshot.ts`** — same treatment for
`app/api/cron/snapshot-followers/route.ts`, exporting `snapshotFollowerCounts()`.

**Wire them into `worker/dm-worker.ts`:**

```ts
import { refreshAllTokens } from "@/lib/token-refresh";
import { snapshotFollowerCounts } from "@/lib/follower-snapshot";

const TOKEN_REFRESH_INTERVAL_MS =
  Number(process.env.TOKEN_REFRESH_INTERVAL_MS ?? 12 * 60 * 60_000);
const FOLLOWER_SNAPSHOT_INTERVAL_MS =
  Number(process.env.FOLLOWER_SNAPSHOT_INTERVAL_MS ?? 24 * 60 * 60_000);

void refreshTokens();
const tokenRefreshTimer = setInterval(() => void refreshTokens(), TOKEN_REFRESH_INTERVAL_MS);
const followerSnapshotTimer = setInterval(() => void snapshotFollowers(), FOLLOWER_SNAPSHOT_INTERVAL_MS);
```

`attach-next-reel` needs **no** timer — the worker already calls `attachPendingNextReels()`
every 5 minutes from its existing `poll()`. Don't double-schedule it.

Clear both timers in the existing `shutdown()` handler.

**Make the worker load `.env`.** Next.js auto-loads `.env`; a standalone `tsx` script does
not. Symptom: worker boots, then logs `DATABASE_URL environment variable is required`.

```json
"worker": "tsx --env-file=${ENV_FILE:-.env} worker/dm-worker.ts"
```

The `${ENV_FILE:-.env}` indirection lets Phase 2 point the worker at `.env.worker`
without editing scripts.

> ⚠️ **SPECIAL NOTE — the repo already contains a scheduler**
>
> `scripts/cron.sh` plus `docs/deploy-dokploy.md` (Gotcha #4) describe the maintainers'
> solution: a fourth container running a `while true` loop that `curl`s the three routes
> every 5 minutes / daily. It is Docker-oriented.
>
> The worker-timer approach here is equivalent and simpler for a single-Mac deployment.
> **Pick one.** Both are idempotent — `refreshAllTokens` moves tokens out of the 10-day
> window, and `recordFollowerSnapshot` upserts per (account, UTC day) — so running both
> is not *incorrect*, just wasteful (duplicate Graph API calls). Never run
> `scripts/cron.sh` *and* the worker timers.

Verify:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

### 1.4 PM2 process manager

```bash
npm install -g pm2
mkdir -p ~/Documents/openreply/logs
```

Create `ecosystem.config.js`:

```javascript
const CWD = "/Users/<user>/Documents/openreply";

const common = {
  cwd: CWD,
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  exp_backoff_restart_delay: 1000,
};

module.exports = {
  apps: [
    {
      name: "openreply-web",
      script: "npm",
      args: "start",            // production build, not `next dev`
      ...common,
      env: { NODE_ENV: "production" },
      error_file: "./logs/web-error.log",
      out_file: "./logs/web-out.log",
      merge_logs: true,
    },
    {
      name: "openreply-worker",
      script: "npm",
      args: "run worker",
      ...common,
      env: { NODE_ENV: "production" },
      error_file: "./logs/worker-error.log",
      out_file: "./logs/worker-out.log",
      merge_logs: true,
    },
    {
      name: "cloudflared",
      script: "cloudflared",
      args: "tunnel run openreply",
      ...common,
      log_file: "./logs/tunnel.log",
      merge_logs: true,
    },
  ],
};
```

Build before starting, since `npm start` needs `.next`:

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
```

Prefer `npm start` over the upstream guide's `npm run dev` — the dev server recompiles per
request and wastes memory on a machine also running Postgres, Redis and the worker.

> ⚠️ **SPECIAL NOTE — `next build` type-checks and can fail on pre-existing errors**
>
> `next dev` tolerates type errors; `next build` does not. A pre-existing error in
> `lib/queue/dm-worker.ts` blocked the production build entirely, which is why upstream's
> `npm run dev` instructions masked it. Any deployment using `npm start` must fix type
> errors first:
>
> ```bash
> npm run typecheck    # run this BEFORE npm run build
> ```

### 1.5 Prevent the machine from sleeping

A sleeping Mac stops the web app, the worker, the tunnel, Postgres and Redis. Clients
silently stop receiving DMs while everything looks configured.

```bash
# run as the human
sudo pmset -a sleep 0          # no idle sleep on AC *or* battery
```

Verify:

```bash
pmset -g custom | grep -E "Battery|AC Power|sleep"
```

Both `Battery Power` and `AC Power` must show `sleep 0`.

> ⚠️ **SPECIAL NOTE — check the battery setting specifically**
>
> The usual default is `sleep 0` on AC but **`sleep 1` on battery** — one minute. Unplug
> the MacBook and the entire stack dies almost immediately, which looks like an
> application bug. `pmset -a sleep 0` fixes both. Always verify with `pmset -g custom`
> rather than assuming.

`pmset -a sleep 0` covers **idle** sleep only. There is also a GUI checkbox under
*System Settings → Battery → Options* → "Prevent automatic sleeping on power adapter when
the display is off", but that is AC-only and does not cover lid close either.

#### Lid-close sleep

Closing the lid normally suspends a MacBook regardless of idle-sleep settings. Supported
clamshell mode (AC power + external display) is the reliable answer, and the display is
what keeps it awake — nothing else substitutes.

If the lid must stay closed without a display, there is an undocumented `pmset` key:

```bash
sudo pmset -a disablesleep 1     # override lid-close sleep
sudo pmset -a disablesleep 0     # restore normal behaviour

pmset -g | grep SleepDisabled    # 1 = lid sleep disabled
```

Caveats to state to the human before enabling it:

- **Not exposed in System Settings.** Undocumented, so it could change between releases.
- **Best-effort on Apple Silicon.** On M-series the lid hall-effect sensor is partially
  hardware-gated, so this is not fully reliable; it works best on AC power and best of all
  with an external display attached. Verify on the actual hardware by closing the lid with a
  real job in flight.
- **System-wide and persistent across reboots.** A Mac that cannot sleep will overheat in a
  bag and drain flat. Never pack it away with this enabled.

> ⚠️ **`caffeinate` does not help here.** Its power assertion blocks *idle* sleep only; the
> forced clamshell sleep ignores power assertions entirely. `caffeinate -dimsu` alone will
> not keep a closed-lid MacBook running.

### 1.6 Survive reboot and network loss

`pm2 startup` only prints a `sudo` command; it does not install anything.

```bash
# run as the human
sudo env PATH=$PATH:<node-bin-dir> <pm2-bin-dir>/pm2 startup launchd -u <user> --hp /Users/<user>
```

Where `<node-bin-dir>` is `dirname $(readlink $(which node))` and `<pm2-bin-dir>` is
usually `/opt/homebrew/lib/node_modules/pm2/bin`. Confirm with `pm2 startup`, which
prints the exact command.

Verify the LaunchAgent exists:

```bash
ls ~/Library/LaunchAgents/pm2.*.plist
```

`~/Library/LaunchAgents/` is loaded by launchd at every login, so the app restores from
`~/.pm2/dump.pm2` automatically.

> ⚠️ **SPECIAL NOTE — Login survival yes, daemon-crash survival no**
>
> Verified by actually running `pm2 kill`: the daemon did **not** come back. PM2's launchd
> template pairs `RunAtLoad: true` with `LaunchOnlyOnce: true`, so the job runs once per
> load and is then unloaded.
>
> What this means:
> - **Reboot / logout → works.** Restores from the dump.
> - **Worker or app crash mid-session → works.** PM2 `autorestart` +
>   `exp_backoff_restart_delay` handles it.
> - **PM2 daemon itself dies mid-session → not covered.** Manual `pm2 resurrect`.
>
> Removing `LaunchOnlyOnce` to enable `KeepAlive` re-runs `pm2 resurrect` in a tight spawn
> loop, because it exits immediately on success. That is worse than the gap. Leave the
> canonical template.

Network loss needs no action: `cloudflared` reconnects its QUIC connections on its own
(observed re-registering on 4 edge locations after restarts), and `womp` (wake on network
access) and `tcpkeepalive` are already enabled by default on macOS.

### 1.7 Verification

Run these in order. Each isolates one layer, which makes the next failure obvious.

```bash
# 1. Services
pm2 status                                  # all three "online"
brew services list | grep -E "postgres|redis"

# 2. Local health
curl -s http://localhost:3000/api/health

# 3. Public health — proves DNS + tunnel + TLS
curl -s https://app.yourdomain.com/api/health

# 4. Meta-required pages
for p in privacy terms data-deletion; do
  printf "%-16s %s\n" "/$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' https://app.yourdomain.com/$p)"
done

# 5. Webhook verification, exactly as Meta performs it
VT=$(grep '^WEBHOOK_VERIFY_TOKEN=' ~/Documents/openreply/.env | cut -d= -f2-)
curl -s -G "https://app.yourdomain.com/api/webhook" \
  --data-urlencode "hub.mode=subscribe" \
  --data-urlencode "hub.verify_token=$VT" \
  --data-urlencode "hub.challenge=1158201444" -w " [%{http_code}]\n"
# expect: 1158201444 [200]

# 6. Cron auth still enforced publicly
curl -s -o /dev/null -w "%{http_code}\n" \
  https://app.yourdomain.com/api/cron/refresh-tokens
# expect: 401
```

Expected health payload:

```json
{"status":"ok","checks":{
  "database":{"status":"ok"},"redis":{"status":"ok","detail":"PONG"},
  "queue":{"status":"ok"},
  "worker":{"healthy":true}}}
```

**Verify the Meta OAuth wiring without a browser.** Generate the authorize URL with the
app's own function and inspect what Meta returns — a login page means the App ID is
correct; `Invalid platform app` means it is not:

```bash
cd ~/Documents/openreply
npx tsx --env-file=.env -e '
import { getAuthorizationUrl } from "./lib/meta/oauth";
console.log(getAuthorizationUrl("https://app.yourdomain.com/api/instagram/callback","PROBE"));
' > /tmp/authurl.txt

curl -sL -A "Mozilla/5.0" "$(cat /tmp/authurl.txt)" -o /tmp/rsp.html
grep -qi "Invalid platform app" /tmp/rsp.html \
  && echo "FAIL: wrong App ID" || echo "PASS: login page returned"
rm -f /tmp/authurl.txt /tmp/rsp.html
```

**Verify token encryption round-trips** with the configured key — a silent failure here
breaks every DM while health stays green:

```bash
npx tsx --env-file=.env -e '
import { encryptToken, decryptToken } from "./lib/meta/oauth";
const t="TEST"; const e=encryptToken(t);
console.log("round-trip:", decryptToken(e)===t, "| not plaintext:", !e.includes(t));
'
```

**End-to-end test** (needs two real Instagram accounts):

1. Sign in at `https://app.yourdomain.com/login` with an allowlisted address.
2. **Settings → Connect Instagram.**
3. Create a campaign on a real post with a keyword.
4. Comment that keyword from a **second** Instagram account.
5. Confirm the DM arrives and appears in `/logs`.

Confirm at the database level:

```bash
cd ~/Documents/openreply
psql -d openreply -c "select username, provider, \"webhookSubscribed\", \"tokenExpiresAt\" from \"InstagramAccount\";"
psql -d openreply -c "select status, \"createdAt\" from \"DmLog\" order by \"createdAt\" desc limit 5;"
# expect SENT rows
psql -d openreply -c "select source, level, message from \"OperationalEvent\" order by \"createdAt\" desc limit 5;"
# connection failures land here with Meta's error text
```

`OperationalEvent` is the single most useful diagnostic: `app/api/instagram/callback/route.ts`
persists any connect failure there with Meta's own message, so a self-hoster sees the reason
in the UI without reading server logs.

---

## Phase 2 — Optional: hybrid Render + Mac worker

Move the web app, database and Redis to Render; keep the worker on the Mac. Motivations:
the Mac sleeps, goes offline, or sits behind NAT; the web tier needs real uptime and TLS.
Costs roughly $24/mo versus $0.

Only do this once Phase 1 is verified working end-to-end.

### 2.1 Render services

Create all three in the **same region**:

| Service | Type | Plan |
|---|---|---|
| PostgreSQL | Managed | Basic-256mb (~$7/mo) |
| Redis | Key Value | Starter (~$10/mo) |
| Web Service | Web Service | Starter (~$7/mo) |

Never use Free: the web service sleeps after 15 minutes and Render deletes Free Postgres
after 30 days.

### 2.2 Build and start commands

**Build** (no database access needed — do **not** migrate here):
```bash
npm install && npm run db:generate && npm run build
```

**Start**:
```bash
npm start
```

### 2.3 Migrations

Run from the Mac against Render's **external** database URL. Docker/Render builds have no
route to the database, so migrating at build time fails with `P1001`.

```bash
cd ~/Documents/openreply
DATABASE_URL="postgresql://...external.../openreply" npm run db:migrate
```

If migrating an existing Phase 1 install, dump first:
```bash
pg_dump "postgresql://<macuser>@localhost:5432/openreply" > backup.sql
psql "postgresql://...external.../openreply" < backup.sql
```

### 2.4 Render web environment

```env
NEXTAUTH_URL=https://openreply-web.onrender.com
NEXTAUTH_SECRET=<identical to Mac>
CRON_SECRET=<identical to Mac>
ENCRYPTION_KEY=<BYTE-IDENTICAL to Mac — see §0.5>
DATABASE_URL=<Render Postgres INTERNAL URL>
REDIS_URL=<Render Redis INTERNAL URL>
RESEND_API_KEY=<same>
EMAIL_FROM=<same>
META_GRAPH_API_VERSION=v25.0
INSTAGRAM_APP_ID=<same>
INSTAGRAM_APP_SECRET=<same>
FACEBOOK_APP_SECRET=<same>
WEBHOOK_VERIFY_TOKEN=<same>
```

Use **internal** URLs for Render→Render. The Mac worker is outside Render's private
network, so it needs **external** URLs.

### 2.5 Mac worker in Phase 2

Create `~/Documents/openreply/.env.worker` with the **external** URLs and every secret
identical to Render's. Then point the worker at it — this is why the npm script uses
`${ENV_FILE:-.env}`:

```bash
ENV_FILE=.env.worker npm run worker
```

In PM2, set `ENV_FILE: ".env.worker"` in the worker app's `env` block. Then delete the
`openreply-web` and `cloudflared` apps from `ecosystem.config.js` — only the worker belongs
on the Mac.

Verify: `curl -s https://openreply-web.onrender.com/api/health` must report
`"worker": {"healthy": true}`. The web app on Render and the worker on the Mac coordinate
purely through shared Postgres and Redis.

### 2.6 Update Meta

Every Meta URL must change to the Render domain, exactly, no trailing slash. Meta does not
reliably follow redirects, so stale values cause silently dead webhooks.

| Setting | New value |
|---|---|
| OAuth redirect URI | `https://openreply-web.onrender.com/api/instagram/callback` |
| Webhook callback | `https://openreply-web.onrender.com/api/webhook` |
| Privacy / Terms / Deletion | `.../privacy`, `.../terms`, `.../data-deletion` |

---

## Special notes and pitfalls

Consolidated. Each is a failure that actually occurred.

### Configuration

| # | Pitfall | Symptom | Fix |
|---|---|---|---|
| 1 | Meta App ID used instead of **Instagram** App ID | `Invalid platform app`; no local log, empty `OperationalEvent` | Use the ID from *API setup with Instagram login → Business login settings* (§0.2) |
| 2 | Webhook callback URL set to `/api/instagram/callback` | *"callback URL or verify token couldn't be validated"* | Webhook is `/api/webhook`; OAuth is `/api/instagram/callback` |
| 3 | Redirect URI trailing slash | `Invalid redirect_uri` | Recheck the saved field; both hops must be byte-identical |
| 4 | `ALLOWED_EMAILS` unset | Anyone can sign in and create workspaces | Always set it — it fails open |
| 5 | `EMAIL_FROM` set to a bare domain | Resend rejects sends | Use a full address on a verified domain |
| 6 | Resend domain not verified | Magic links silently fail | Add DNS records, wait for **verified** |
| 7 | `.env` edited, process not restarted | Confusing 401s / stale config | `pm2 restart openreply-web openreply-worker` |

### URLs — the most common user error

`app/api/automations/route.ts` validates the tracked link as:

```ts
trackedDestinationUrl: z.union([z.string().url(), z.literal("")])
```

`z.string().url()` requires a **scheme**. Verified behaviour:

| Input | Result |
|---|---|
| `mixbash.com` | ❌ `Invalid URL` |
| `www.example.com` | ❌ `Invalid URL` |
| `example.com` | ❌ `Invalid URL` |
| `//example.com` | ❌ `Invalid URL` |
| `https://mixbash.com/offer` | ✅ |
| `https://t.co/abc` | ✅ |
| `https://example.com?utm_source=ig` | ✅ |
| *(empty)* | ✅ means "no tracked link" |

**A bare domain is the mistake.** Prefix with `https://`. Query strings and shortened links
are fine. If improving the UX, replace the message with something actionable:

```ts
trackedDestinationUrl: z.union([
  z.string().url({ message: "Enter a full URL starting with https://" }),
  z.literal(""),
]),
```

Note the schema accepts any scheme, including `javascript:`. Not exploitable in current
usage (the link is owner-configured and stored per workspace, never rendered to
commenters), but tighten it if these URLs are ever surfaced publicly.

### Toolchain and code

| # | Pitfall | Symptom | Fix |
|---|---|---|---|
| 8 | Worker doesn't load `.env` | `DATABASE_URL environment variable is required` | `tsx --env-file=${ENV_FILE:-.env}` (§1.3) |
| 9 | `next build` fails on pre-existing type error | Build refuses to run | `npm run typecheck` first; fix before `npm start` |
| 10 | `dotenv` imported but undeclared | `db:migrate` module-not-found after a dependency change | `npm install --save-dev dotenv` |
| 11 | Homebrew sandbox deadlock | `brew install` hangs forever | Patch `Sandbox.available?` → `false` (§0.1) |
| 12 | `snapshot-followers` cron dropped | Follower history permanently incomplete | Schedule it — Instagram keeps only ~30 days (§1.3) |
| 13 | `scripts/cron.sh` *and* worker timers both running | Duplicate Graph API calls | Pick one mechanism (§1.3) |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `worker.healthy: false` | Worker down, or cannot reach Redis | `pm2 status`; verify `REDIS_URL` |
| `Invalid platform app` | Wrong App ID | §0.2, note 1 |
| `Invalid redirect_uri` | Trailing slash, or registered in the wrong panel | §0.2, notes 2–3 |
| Webhook test OK, real comments ignored | App not Live, or account not public | Publish; make the post public |
| `Invalid URL` on campaign save | Missing `https://` | See URL table above |
| Comments arrive, no DM | Worker down, or decryption failure | `pm2 logs openreply-worker`; confirm `ENCRYPTION_KEY` matches |
| Login link never arrives | Resend domain unverified, or address not allowlisted | §0.3; check `ALLOWED_EMAILS` |
| Everything fine on localhost, dead via public URL | Tunnel down or DNS missing | `pm2 logs cloudflared`; `dig +short <hostname>` |
| Works unplugged on battery for ~1 min then dies | `sleep 1` on battery | `sudo pmset -a sleep 0` (§1.5) |
| Dead after reboot | `pm2 startup` never run | §1.6 |
| 401 "API key is invalid" with a valid key | Process not restarted after `.env` edit | §1.2, note 7 |
| Works with the lid open, dies when closed | Lid-close sleep, not idle sleep | `disablesleep 1` or use clamshell (§1.5) |
| `caffeinate` running but Mac still sleeps on lid close | Expected — assertions don't cover lid sleep | `disablesleep 1` (§1.5) |
| Grows then flatlines | Long-lived token expired | Check `tokenExpiresAt`; re-run refresh; reconnection may be required after 60 days offline |
| `brew upgrade` hangs | Sandbox patch still applied | Revert per §0.1 |

---

## Operations reference

```bash
cd ~/Documents/openreply

# Processes
pm2 status
pm2 logs                       # all
pm2 logs openreply-worker --lines 100
pm2 restart openreply-web openreply-worker
pm2 save
pm2 monit

# After any .env change
pm2 restart openreply-web openreply-worker && pm2 save

# Code changes
npm run typecheck && npm run lint && npm test
npm run build
pm2 restart openreply-web openreply-worker

# Health
curl -s http://localhost:3000/api/health
curl -s https://app.yourdomain.com/api/health

# Manual cron runs (CRON_SECRET from .env)
CRON=$(grep '^CRON_SECRET=' .env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $CRON" \
  https://app.yourdomain.com/api/cron/refresh-tokens

# Database
pg_dump "postgresql://$(whoami)@localhost:5432/openreply" > backup.sql
psql -d openreply -c "select status, \"createdAt\" from \"DmLog\" order by \"createdAt\" desc limit 10;"
psql -d openreply -c "select source, level, message from \"OperationalEvent\" order by \"createdAt\" desc limit 10;"

# Power
pmset -g custom                    # idle-sleep per power source
sudo pmset -a sleep 0              # no idle sleep, AC + battery
sudo pmset -a disablesleep 1       # override lid-close sleep (see §1.5 caveats)
sudo pmset -a disablesleep 0       # restore lid-close sleep
pmset -g | grep SleepDisabled

# Tunnel
cloudflared tunnel info openreply
cloudflared tunnel route dns openreply app.yourdomain.com
```

### Rotating `ENCRYPTION_KEY`

Requires disconnecting and reconnecting every Instagram account — the worker cannot decrypt
existing tokens otherwise. Rotate `NEXTAUTH_SECRET` and `CRON_SECRET` freely (just restart).
If any secret was pasted into a chat, log, or commit, rotate it and never commit `.env`.

---

## Proven working configuration

Verified end-to-end on macOS 15.5 (arm64), Node 26.10.0, PostgreSQL 16.15, Redis 8.10.2,
cloudflared 2026.9.3, Next.js 16.2.6, Prisma 7.8.0.

Final observed state after a successful test campaign:

```
health: ok | db: ok | redis: ok | queue: ok | worker: true
InstagramAccount: username=<handle> provider=META webhookSubscribed=t
DmLog: 2 rows, status=SENT
OperationalEvent: 0 rows (no errors)
```

All three PM2 apps `online`, public health `200` over HTTPS through the tunnel.
