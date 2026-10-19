/* eslint-env node */
// Netlify scheduled function: every hour, asks the app to advance due
// scheduled syncs (app/routes/internal.sync.tsx). Scheduled functions run only
// on each site's published production deploy, and for at most 30 seconds.
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
  const response = await fetch(new URL("/internal/sync", base), {
    method: "POST",
    headers: { "x-sync-signature": `${ts}.${signature}` },
    signal: AbortSignal.timeout(28_000),
  });
  console.log(`[scheduled-sync] ${response.status} ${await response.text()}`);
};

export const config = { schedule: "@hourly" };
