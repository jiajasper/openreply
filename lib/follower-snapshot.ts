import { prisma } from "@/lib/db/client";
import { createInstagramContext, getUserInfo } from "@/lib/instagram/provider";
import {
  backfillFollowerHistory,
  recordFollowerSnapshot,
} from "@/lib/reports/follower-history";

export interface FollowerSnapshotResult {
  accounts: number;
  recorded: number;
  backfilled: number;
  failures: Array<{ username: string; reason: string }>;
}

/**
 * Records one follower total per connected account per day.
 *
 * Instagram retains only ~30 days of account insights, so this job is the only
 * source of longer-range follower history. Missing a run loses that day
 * permanently — there is no way to backfill beyond the insights window.
 *
 * Lives here rather than in the cron route so the DM worker can drive it on a
 * timer, for the same reason as `refreshAllTokens`: a self-hosted deployment
 * has no Vercel cron to call the route.
 *
 * One account failing is collected into `failures` and never aborts the run.
 */
export async function snapshotFollowerCounts(): Promise<FollowerSnapshotResult> {
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      OR: [
        { provider: "META", accessToken: { not: "" } },
        { provider: "ZERNIO", zernioAccountId: { not: null } },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
      provider: true,
      metaLogin: true,
      zernioAccountId: true,
    },
  });

  let recorded = 0;
  let backfilled = 0;
  const failures: Array<{ username: string; reason: string }> = [];

  for (const account of accounts) {
    try {
      const token = await createInstagramContext(account);
      if (token.provider === "ZERNIO") {
        const imported = await backfillFollowerHistory({
          instagramAccountId: account.id,
          accessToken: token,
          instagramId: account.instagramId,
          currentFollowers: 0,
        });
        backfilled += imported;
        if (imported === 0)
          failures.push({
            username: account.username,
            reason:
              "Zernio follower history is unavailable or already stored (Analytics add-on required)",
          });
        continue;
      }
      const info = await getUserInfo({ context: token });

      if (typeof info.followers_count !== "number") {
        failures.push({
          username: account.username,
          reason: "followers_count not returned",
        });
        continue;
      }

      await recordFollowerSnapshot(account.id, info.followers_count);
      recorded += 1;

      // First time we see this account, try to recover the last 30 days.
      const existing = await prisma.followerSnapshot.count({
        where: { instagramAccountId: account.id },
      });
      if (existing <= 1) {
        backfilled += await backfillFollowerHistory({
          instagramAccountId: account.id,
          accessToken: token,
          instagramId: account.instagramId,
          currentFollowers: info.followers_count,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failures.push({ username: account.username, reason });
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            workspaceId: account.workspaceId,
            message: "Follower snapshot failed",
            payload: { username: account.username, reason },
          },
        })
        .catch(() => {});
    }
  }

  return {
    accounts: accounts.length,
    recorded,
    backfilled,
    failures,
  };
}
