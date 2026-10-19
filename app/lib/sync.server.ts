import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getScanState, startScan, type Scope } from "./catalog.server";
import { FIX_FIELDS, FREQUENCIES, type FixField, type Frequency } from "./fixes";
import { advanceFix, createFixBatch } from "./fixes.server";
import { getPlan } from "./plans.server";
import { canUseWarehouse, VARIANT_LIMIT } from "./plans";
import {
  advanceComparison,
  createComparison,
  getProvider,
  loadCredentials,
  PROVIDERS,
} from "./wms/index.server";

// Scheduled sync: for each enabled warehouse connection that is due, read the
// catalog again, compare it with the warehouse and, if chosen, fix the chosen
// fields in Shopify (an undoable batch, like a manual fix). A Netlify scheduled
// function calls runSync every few minutes; each call advances runs a little.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After a step that returned at once (another request holds its lock), wait a moment. */
async function pauseIfIdle(startedAt: number) {
  if (Date.now() - startedAt < 500) await sleep(1000);
}

const nextRun = (frequency: string, from = new Date()) =>
  new Date(
    from.getTime() + (FREQUENCIES[frequency as Frequency]?.hours ?? 24) * 3_600_000,
  );

export const parseFields = (raw: string | null | undefined): FixField[] => {
  try {
    const list = JSON.parse(raw ?? "[]") as string[];
    return FIX_FIELDS.filter((f) => list.includes(f));
  } catch {
    return [];
  }
};

export async function saveSyncSetting(
  shop: string,
  provider: string,
  opts: { enabled: boolean; frequency: string; fixFields: FixField[]; scope?: string },
) {
  const frequency = opts.frequency in FREQUENCIES ? opts.frequency : "daily";
  const existing = await prisma.syncSetting.findUnique({
    where: { shop_provider: { shop, provider } },
  });
  // A newly enabled sync runs soon; a changed schedule counts from the last run.
  const nextRunAt = !opts.enabled
    ? null
    : existing?.enabled && existing.lastRunAt
      ? nextRun(frequency, existing.lastRunAt)
      : new Date(Date.now() + 60_000);
  const data = {
    enabled: opts.enabled,
    frequency,
    fixFields: JSON.stringify(opts.fixFields),
    scope: opts.scope === "active_draft" ? "active_draft" : "active",
    nextRunAt,
    ...(opts.enabled
      ? {}
      : { stage: "idle", runId: null, scanId: null, comparisonId: null, fixBatchId: null }),
  };
  if (!opts.enabled && existing?.runId) {
    await prisma.syncRun.updateMany({
      where: { id: existing.runId, status: "running" },
      data: { status: "skipped", message: "Scheduled sync was turned off", finishedAt: new Date() },
    });
  }
  return prisma.syncSetting.upsert({
    where: { shop_provider: { shop, provider } },
    create: { shop, provider, ...data },
    update: data,
  });
}

type Setting = NonNullable<Awaited<ReturnType<typeof prisma.syncSetting.findUnique>>>;

/** Ends the current run: logs it (see History) and schedules the next one. */
async function finish(s: Setting, status: "done" | "failed" | "skipped", message: string) {
  const run = {
    status,
    message,
    comparisonId: s.comparisonId,
    fixBatchId: s.fixBatchId,
    finishedAt: new Date(),
  };
  if (s.runId) {
    await prisma.syncRun.updateMany({ where: { id: s.runId }, data: run });
  } else {
    await prisma.syncRun.create({ data: { shop: s.shop, provider: s.provider, ...run } });
  }
  return prisma.syncSetting.update({
    where: { id: s.id },
    data: {
      stage: "idle",
      runId: null,
      scanId: null,
      comparisonId: null,
      fixBatchId: null,
      lastStatus: status,
      lastMessage: message,
      nextRunAt: nextRun(s.frequency),
    },
  });
}

/**
 * Moves one sync run forward until it has to wait (for Shopify's export, the
 * next comparison or fix step) or runs out of time.
 */
export async function advanceSync(setting: Setting, until: number): Promise<void> {
  let s = setting;
  const { shop } = s;

  let admin: AdminApiContext;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    await prisma.syncSetting.update({
      where: { id: s.id },
      data: { enabled: false, stage: "idle", lastStatus: "failed", lastMessage: "SKU Doctor is no longer installed" },
    });
    return;
  }

  while (Date.now() < until) {
    if (s.stage === "idle") {
      if (!PROVIDERS[s.provider] || !(await loadCredentials(shop, s.provider))) {
        await finish(s, "skipped", "The warehouse system isn't connected");
        return;
      }
      if (!canUseWarehouse(await getPlan(shop, admin))) {
        await finish(s, "skipped", "Scheduled sync is part of the Warehouse plan");
        return;
      }
      const scan = await startScan(shop, admin);
      if (scan.status === "failed") {
        await finish(s, "failed", scan.error ?? "Couldn't read the Shopify catalog");
        return;
      }
      const run = await prisma.syncRun.create({
        data: { shop, provider: s.provider, status: "running" },
      });
      s = await prisma.syncSetting.update({
        where: { id: s.id },
        data: {
          stage: "scanning",
          runId: run.id,
          scanId: scan.id,
          lastRunAt: run.startedAt,
          lastStatus: null,
          lastMessage: null,
        },
      });
      continue;
    }

    if (s.stage === "scanning") {
      const stepStart = Date.now();
      await getScanState(shop, admin); // checks the export, or imports the next part
      const scan = s.scanId
        ? await prisma.catalogScan.findUnique({ where: { id: s.scanId } })
        : null;
      if (scan?.status === "running") {
        // Shopify is still exporting; check again in a few seconds.
        await sleep(4000);
        continue;
      }
      if (scan?.status === "importing") {
        await pauseIfIdle(stepStart);
        continue;
      }
      if (scan?.status === "failed") {
        await finish(s, "failed", scan.error ?? "Couldn't read the Shopify catalog");
        return;
      }
      const running = await prisma.wmsComparison.findFirst({
        where: { shop, provider: s.provider, status: "running" },
      });
      let comparisonId = running?.id;
      if (!comparisonId) {
        const plan = await getPlan(shop, admin);
        const created = await createComparison(
          shop,
          getProvider(s.provider),
          s.scope as Scope,
          VARIANT_LIMIT[plan],
        );
        if (!created) {
          await finish(s, "failed", "Couldn't read the Shopify catalog");
          return;
        }
        comparisonId = created.id;
      }
      s = await prisma.syncSetting.update({
        where: { id: s.id },
        data: { stage: "comparing", comparisonId },
      });
      await prisma.syncRun.updateMany({
        where: { id: s.runId ?? "" },
        data: { comparisonId },
      });
      continue;
    }

    if (s.stage === "comparing") {
      if (!s.comparisonId) {
        await finish(s, "failed", "Lost track of the comparison");
        return;
      }
      const stepStart = Date.now();
      await advanceComparison(s.comparisonId);
      const comparison = await prisma.wmsComparison.findUnique({ where: { id: s.comparisonId } });
      if (!comparison || comparison.status === "failed") {
        await finish(s, "failed", comparison?.error ?? "The comparison failed");
        return;
      }
      if (comparison.status === "running") {
        await pauseIfIdle(stepStart);
        continue;
      }

      const differences = comparison.mismatchCount.toLocaleString();
      const fields = parseFields(s.fixFields);
      if (fields.length === 0) {
        await finish(s, "done", `${differences} differences found`);
        return;
      }
      const created = await createFixBatch({
        shop,
        provider: s.provider,
        comparisonId: comparison.id,
        fields,
        source: "sync",
      });
      if (!created.batch) {
        // Nothing to fix, or a manual fix is running: report and try next time.
        await finish(
          s,
          "done",
          `${differences} differences found; ${created.error ?? "nothing to fix"}`,
        );
        return;
      }
      s = await prisma.syncSetting.update({
        where: { id: s.id },
        data: { stage: "fixing", fixBatchId: created.batch.id },
      });
      await prisma.syncRun.updateMany({
        where: { id: s.runId ?? "" },
        data: { fixBatchId: created.batch.id },
      });
      continue;
    }

    if (s.stage === "fixing") {
      if (!s.fixBatchId) {
        await finish(s, "failed", "Lost track of the fix");
        return;
      }
      const stepStart = Date.now();
      await advanceFix(s.fixBatchId, admin);
      const batch = await prisma.fixBatch.findUnique({ where: { id: s.fixBatchId } });
      if (!batch || batch.status === "failed") {
        await finish(s, "failed", batch?.error ?? "The fix failed");
        return;
      }
      if (batch.status === "applying") {
        await pauseIfIdle(stepStart);
        continue;
      }
      await finish(
        s,
        "done",
        `Fixed ${batch.applied.toLocaleString()} of ${batch.total.toLocaleString()} values in Shopify` +
          (batch.failed ? ` (${batch.failed.toLocaleString()} failed)` : ""),
      );
      return;
    }

    await finish(s, "failed", `Unknown stage ${s.stage}`);
    return;
  }
}

const dueWhere = () => ({
  enabled: true,
  OR: [{ stage: { not: "idle" } }, { nextRunAt: { lte: new Date() } }],
});

/** Syncs that are due or in progress (for the hourly dispatcher). */
export const dueSettings = (take = 500) =>
  prisma.syncSetting.findMany({
    where: dueWhere(),
    orderBy: { nextRunAt: "asc" },
    take,
    select: { id: true, shop: true, provider: true },
  });

const LEASE_MS = 15 * 60_000;

/** Gives one background worker a sync for up to 15 minutes; false if taken. */
export async function claimLease(settingId: string) {
  const now = new Date();
  const claimed = await prisma.syncSetting.updateMany({
    where: { id: settingId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return claimed.count > 0;
}

export const releaseLease = (settingId: string) =>
  prisma.syncSetting.updateMany({ where: { id: settingId }, data: { leaseUntil: null } });

/**
 * Advances one sync for up to `budgetMs` (a background worker calls this in a
 * loop). Returns true while the sync still has work to do.
 */
export async function runOne(settingId: string, budgetMs = 20_000) {
  const setting = await prisma.syncSetting.findFirst({ where: { id: settingId, ...dueWhere() } });
  if (!setting) return false;
  try {
    await advanceSync(setting, Date.now() + budgetMs - 7000);
  } catch (error) {
    const current = await prisma.syncSetting.findUnique({ where: { id: setting.id } });
    await finish(current ?? setting, "failed", error instanceof Error ? error.message : String(error));
  }
  const after = await prisma.syncSetting.findUnique({ where: { id: settingId } });
  return !!after && after.enabled && after.stage !== "idle";
}

/** Advances due and in-progress syncs for up to `budgetMs`. */
export async function runSync(budgetMs = 20_000) {
  const until = Date.now() + budgetMs;
  const settings = await prisma.syncSetting.findMany({
    where: {
      enabled: true,
      OR: [{ stage: { not: "idle" } }, { nextRunAt: { lte: new Date() } }],
    },
    orderBy: { nextRunAt: "asc" },
    take: 25,
  });
  const report: string[] = [];
  for (const setting of settings) {
    // Leave room for one more comparison or fix step (about 6 seconds).
    if (Date.now() > until - 7000) break;
    try {
      await advanceSync(setting, until - 7000);
      report.push(`${setting.shop}/${setting.provider}: ok`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await prisma.syncSetting.findUnique({ where: { id: setting.id } });
      await finish(current ?? setting, "failed", message);
      report.push(`${setting.shop}/${setting.provider}: ${message}`);
    }
  }
  return report;
}
