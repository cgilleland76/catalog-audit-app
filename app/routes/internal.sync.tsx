import type { ActionFunctionArgs } from "react-router";

import { signSync, verifySync } from "../lib/sync-signature.server";
import { claimLease, dueSettings, releaseLease, runOne, runSync } from "../lib/sync.server";
import prisma from "../db.server";
import { runInBackground } from "../lib/background.server";
import { unauthenticated } from "../shopify.server";
import { advanceComparison } from "../lib/wms/index.server";
import { activeFix, advanceFix } from "../lib/fixes.server";

// Scheduled sync entry point (signed requests only).
// - With { dispatch: true } (or no body): the hourly dispatch. The scheduled
//   function (netlify/functions/scheduled-sync.mjs) hands it to a background
//   worker, which calls again while it returns pending. Each due sync gets its
//   own background worker, so any number of stores sync side by side.
// - With { settingId }: a background worker
//   (netlify/functions/sync-worker-background.mjs) advancing one sync.
// - With { comparisonId } or { batchId }: a background worker advancing a
//   comparison, fix or undo started from a page (app/lib/background.server.ts).
export const loader = () => new Response("Method not allowed", { status: 405 });

// Background workers started at once by the hourly dispatch.
const DISPATCH_PARALLEL = 10;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!verifySync(request.headers.get("x-sync-signature"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    settingId?: string;
    comparisonId?: string;
    batchId?: string;
  };
  const until = Date.now() + 20_000;
  const pause = () => new Promise((r) => setTimeout(r, 1000));

  if (body.comparisonId) {
    for (;;) {
      await advanceComparison(body.comparisonId); // no-op while another step holds it
      const c = await prisma.wmsComparison.findUnique({ where: { id: body.comparisonId } });
      if (!c || c.status !== "running") return Response.json({ pending: false });
      if (Date.now() + 7000 > until) return Response.json({ pending: true });
      await pause();
    }
  }

  if (body.batchId) {
    const batch = await prisma.fixBatch.findUnique({ where: { id: body.batchId } });
    if (!batch) return Response.json({ pending: false });
    const { admin } = await unauthenticated.admin(batch.shop);
    // Works through the shop's active fixes in order (newest undo first), so an
    // undo spanning several fixes ends at the oldest value.
    for (;;) {
      const active = await activeFix(batch.shop);
      if (!active) return Response.json({ pending: false });
      await advanceFix(active.id, admin);
      if (Date.now() + 7000 > until) return Response.json({ pending: true });
      await pause();
    }
  }

  if (body.settingId) {
    const pending = await runOne(body.settingId);
    if (!pending) await releaseLease(body.settingId);
    return Response.json({ pending });
  }

  // The hourly dispatch ({ dispatch: true } from a background worker, which
  // calls again while this returns pending; or no body). Starts a worker for
  // each due sync, DISPATCH_PARALLEL at a time, until the time budget is spent.
  const base = process.env.SHOPIFY_APP_URL || process.env.URL;
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const startWorker = async (setting: { id: string }) => {
    if (!(await claimLease(setting.id))) return null; // a worker already has it
    try {
      const res = await fetch(new URL("/.netlify/functions/sync-worker-background", base), {
        method: "POST",
        headers: { "x-sync-signature": signSync(secret), "content-type": "application/json" },
        body: JSON.stringify({ settingId: setting.id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`worker returned ${res.status}`);
      return true;
    } catch {
      await releaseLease(setting.id); // left for the next pass
      return false;
    }
  };

  let dispatched = 0;
  let failed = 0;
  const tried = new Set<string>();
  while (Date.now() + 5000 < until) {
    const due = (await dueSettings(DISPATCH_PARALLEL * 5, { unleased: true })).filter(
      (s) => !tried.has(s.id),
    );
    if (!due.length) break;
    for (let i = 0; i < due.length && Date.now() + 5000 < until; i += DISPATCH_PARALLEL) {
      const group = due.slice(i, i + DISPATCH_PARALLEL);
      group.forEach((s) => tried.add(s.id));
      for (const started of await Promise.all(group.map(startWorker))) {
        if (started === true) dispatched++;
        if (started === false) failed++;
      }
    }
    if (failed && !dispatched) break; // workers can't start; the next run retries
  }

  // Comparisons and fixes started from a page whose worker stopped (or that
  // started before workers ran them) get a new one.
  const stale = new Date(Date.now() - 2 * 60_000);
  const idle = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: stale } }] };
  const [comparisons, batches] = await Promise.all([
    prisma.wmsComparison.findMany({
      where: { status: "running", startedAt: { lt: stale }, ...idle },
      select: { id: true },
      take: 200,
    }),
    prisma.fixBatch.findMany({
      where: { status: { in: ["applying", "undoing"] }, createdAt: { lt: stale }, ...idle },
      select: { id: true },
      take: 200,
    }),
  ]);
  const restarts = [
    ...comparisons.map((c) => () => runInBackground({ comparisonId: c.id })),
    ...batches.map((b) => () => runInBackground({ batchId: b.id })),
  ];
  for (let i = 0; i < restarts.length && Date.now() + 3000 < until; i += DISPATCH_PARALLEL) {
    await Promise.all(restarts.slice(i, i + DISPATCH_PARALLEL).map((run) => run()));
  }

  // Running locally there are no background workers: advance syncs here.
  const report = !process.env.NETLIFY && failed ? await runSync() : [];
  const more =
    !(failed && !dispatched) &&
    // Failed starts are the only tried syncs still unleased; look past them.
    (await dueSettings(failed + 1, { unleased: true })).some((s) => !tried.has(s.id));
  return Response.json({ pending: more, dispatched, failed, inline: report });
};
