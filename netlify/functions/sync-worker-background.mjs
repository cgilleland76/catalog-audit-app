/* eslint-env node */
// Netlify background function (up to 15 minutes): advances one job by calling
// the app's /internal/sync until it's finished. A job is a scheduled sync
// ({ settingId }, started by the hourly dispatcher) or a comparison, fix or
// undo started from a page ({ comparisonId } / { batchId }). Requests are
// signed both ways.
import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (secret) => {
  const ts = String(Date.now());
  return `${ts}.${createHmac("sha256", secret).update(`sync:${ts}`).digest("hex")}`;
};

const verified = (header, secret) => {
  const [ts, signature] = (header ?? "").split(".");
  if (!secret || !ts || !signature || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(`sync:${ts}`).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export default async (request) => {
  const base = process.env.SHOPIFY_APP_URL || process.env.URL;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!verified(request.headers.get("x-sync-signature"), secret)) return;
  const job = await request.json();
  const label = job.settingId ?? job.comparisonId ?? job.batchId;
  const until = Date.now() + 14 * 60_000;

  while (Date.now() < until) {
    const response = await fetch(new URL("/internal/sync", base), {
      method: "POST",
      headers: { "x-sync-signature": sign(secret), "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => ({ ok: false, status: String(error) }));
    if (!response.ok) {
      console.error(`[sync-worker] ${label}: ${response.status}`);
      if (response.status === 401) return;
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    const { pending } = await response.json();
    if (!pending) return;
  }
  if (job.settingId) {
    console.log(`[sync-worker] ${label}: still running; the next hourly run continues it`);
    return;
  }
  // A page-started job hands over to a fresh worker before this one's time is up.
  await fetch(new URL("/.netlify/functions/sync-worker-background", base), {
    method: "POST",
    headers: { "x-sync-signature": sign(secret), "content-type": "application/json" },
    body: JSON.stringify(job),
  }).catch((error) => console.error(`[sync-worker] ${label}: couldn't continue: ${error}`));
};
