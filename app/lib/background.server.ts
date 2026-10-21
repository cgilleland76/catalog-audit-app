import { signSync } from "./sync-signature.server";

// Long jobs started from a page (a comparison, a fix or an undo) also run in a
// Netlify background function, so they finish even after the merchant leaves
// the page. The open page keeps stepping them too; their locks stop two steps
// from running at once.

export type BackgroundJob = { comparisonId: string } | { batchId: string };

/** Starts a background worker for the job; false if it couldn't be started. */
export async function runInBackground(job: BackgroundJob) {
  const base = process.env.SHOPIFY_APP_URL || process.env.URL;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!base || !secret) return false;
  try {
    const res = await fetch(new URL("/.netlify/functions/sync-worker-background", base), {
      method: "POST",
      headers: { "x-sync-signature": signSync(secret), "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
