import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { refreshLongLivedToken } from "@/lib/meta/client";

const DAYS_BEFORE_EXPIRY = 10;

export interface TokenRefreshOutcome {
  instagramAccountId: string;
  username: string;
  status: "refreshed" | "failed";
  error?: string;
}

export interface TokenRefreshResult {
  totalProcessed: number;
  workspacesReset: number;
  results: TokenRefreshOutcome[];
}

/**
 * Refreshes every META account whose token expires within the next 10 days, and
 * rolls the per-workspace usage period over when the calendar month changes.
 *
 * Lives here rather than in the cron route so the DM worker can drive it on a
 * timer. A self-hosted deployment has no Vercel cron, so without the worker
 * calling this nothing would ever refresh a long-lived token and every
 * connected account would silently stop receiving comments.
 *
 * A refresh that fails for one account is recorded as an operational event and
 * never aborts the run: the remaining accounts still need their turn.
 */
export async function refreshAllTokens(): Promise<TokenRefreshResult> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + DAYS_BEFORE_EXPIRY);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      provider: "META",
      // Unified login tokens cannot be refreshed with ig_refresh_token; one
      // that expires needs the client to connect again.
      metaLogin: "INSTAGRAM",
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
    },
  });

  const results: TokenRefreshOutcome[] = [];

  for (const account of accountsToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return {
    totalProcessed: accountsToRefresh.length,
    workspacesReset: usageReset.count,
    results,
  };
}
