import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import { refreshAllTokens } from "@/lib/token-refresh";
import { snapshotFollowerCounts } from "@/lib/follower-snapshot";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
// Long-lived tokens last 60 days, so twice a day is far more often than needed
// and still leaves plenty of margin if a run fails.
const TOKEN_REFRESH_INTERVAL_MS = Number(
  process.env.TOKEN_REFRESH_INTERVAL_MS ?? 12 * 60 * 60_000
);
// Once a day, matching the cadence `vercel.json` used. Skipping a day loses
// that day's follower count for good, since Instagram only keeps ~30 days of
// insights to backfill from.
const FOLLOWER_SNAPSHOT_INTERVAL_MS = Number(
  process.env.FOLLOWER_SNAPSHOT_INTERVAL_MS ?? 24 * 60 * 60_000
);
// Sweeping every account calls the Graph API once each, so hold the first run
// until after boot rather than competing with the worker's other startup work.
const FOLLOWER_SNAPSHOT_STARTUP_DELAY_MS = 60_000;

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function refreshTokens() {
  try {
    const result = await refreshAllTokens();
    if (result.totalProcessed > 0 || result.workspacesReset > 0) {
      console.log("[DM Worker] Token refresh:", result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Token refresh failed:", message);
  }
}

async function snapshotFollowers() {
  try {
    const result = await snapshotFollowerCounts();
    if (result.accounts > 0) {
      console.log("[DM Worker] Follower snapshot:", result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Follower snapshot failed:", message);
  }
}

// These two replace the Vercel crons declared in vercel.json, which do not run
// on a self-hosted deployment. `attach-next-reel` needs no timer here because
// `poll()` above already covers it every few minutes.
void refreshTokens();
const tokenRefreshTimer = setInterval(
  () => void refreshTokens(),
  TOKEN_REFRESH_INTERVAL_MS
);

setTimeout(
  () => void snapshotFollowers(),
  FOLLOWER_SNAPSHOT_STARTUP_DELAY_MS
);
const followerSnapshotTimer = setInterval(
  () => void snapshotFollowers(),
  FOLLOWER_SNAPSHOT_INTERVAL_MS
);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(tokenRefreshTimer);
  clearInterval(followerSnapshotTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
