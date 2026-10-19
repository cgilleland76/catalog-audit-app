/* eslint-env node */
// Netlify background function (up to 15 minutes): advances one scheduled sync
// by calling the app's /internal/sync with { settingId } until it's finished.
// Started by /internal/sync's hourly dispatcher; requests are signed both ways.
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
  const { settingId } = await request.json();
  const until = Date.now() + 14 * 60_000;

  while (Date.now() < until) {
    const response = await fetch(new URL("/internal/sync", base), {
      method: "POST",
      headers: { "x-sync-signature": sign(secret), "content-type": "application/json" },
      body: JSON.stringify({ settingId }),
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => ({ ok: false, status: String(error) }));
    if (!response.ok) {
      console.error(`[sync-worker] ${settingId}: ${response.status}`);
      if (response.status === 401) return;
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    const { pending } = await response.json();
    if (!pending) return;
  }
  console.log(`[sync-worker] ${settingId}: still running; the next hourly run continues it`);
};
