import type { ActionFunctionArgs } from "react-router";

import { signSync, verifySync } from "../lib/sync-signature.server";
import { claimLease, dueSettings, releaseLease, runOne, runSync } from "../lib/sync.server";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { advanceComparison } from "../lib/wms/index.server";
import { activeFix, advanceFix } from "../lib/fixes.server";

// Scheduled sync entry point (signed requests only).
// - With no body: the hourly dispatcher (netlify/functions/scheduled-sync.mjs).
//   Each due sync is handed to its own background worker, so many stores sync
//   side by side; if a worker can't be started, the sync runs here instead.
// - With { settingId }: a background worker
//   (netlify/functions/sync-worker-background.mjs) advancing one sync.
// - With { comparisonId } or { batchId }: a background worker advancing a
//   comparison, fix or undo started from a page (app/lib/background.server.ts).
export const loader = () => new Response("Method not allowed", { status: 405 });

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

  const base = process.env.SHOPIFY_APP_URL || process.env.URL;
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  let dispatched = 0;
  let inline = false;
  for (const setting of await dueSettings()) {
    if (!(await claimLease(setting.id))) continue; // a worker already has it
    try {
      const res = await fetch(new URL("/.netlify/functions/sync-worker-background", base), {
        method: "POST",
        headers: { "x-sync-signature": signSync(secret), "content-type": "application/json" },
        body: JSON.stringify({ settingId: setting.id }),
      });
      if (!res.ok) throw new Error(`worker returned ${res.status}`);
      dispatched++;
    } catch {
      await releaseLease(setting.id);
      inline = true;
    }
  }
  // No background workers (e.g. running locally): advance syncs here.
  const report = inline ? await runSync() : [];
  return Response.json({ dispatched, inline: report });
};
