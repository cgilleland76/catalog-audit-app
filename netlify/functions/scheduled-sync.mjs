/* eslint-env node */
// Netlify scheduled function: every hour, starts a background worker for the
// dispatch, which hands each due scheduled sync to its own worker
// (app/routes/internal.sync.tsx). It doesn't touch the database itself, so a
// database still waking up can't make it fail; the worker retries until it's
// awake. Hourly keeps the database idle (and cheap) between runs. Scheduled
// functions run only on each site's published production deploy, and for at
// most 30 seconds.
import { createHmac } from "node:crypto";

export default async () => {
  const base = process.env.SHOPIFY_APP_URL || process.env.URL;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!base || !secret) {
    console.error("[scheduled-sync] SHOPIFY_APP_URL (or URL) and SHOPIFY_API_SECRET must be set");
    return;
  }
  const ts = String(Date.now());
  const signature = createHmac("sha256", secret).update(`sync:${ts}`).digest("hex");
  const response = await fetch(new URL("/.netlify/functions/sync-worker-background", base), {
    method: "POST",
    headers: { "x-sync-signature": `${ts}.${signature}`, "content-type": "application/json" },
    body: JSON.stringify({ dispatch: true }),
    signal: AbortSignal.timeout(20_000),
  });
  // Background functions answer 202 at once and run on their own.
  console.log(`[scheduled-sync] dispatch worker: ${response.status}`);
};

export const config = { schedule: "@hourly" };
