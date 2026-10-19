import { createHmac, timingSafeEqual } from "node:crypto";

// Requests between the scheduled function, background workers and
// /internal/sync carry "<timestamp>.<HMAC of `sync:<timestamp>`>" signed with
// the app's API secret (see netlify/functions/*.mjs, which sign the same way).
const MAX_AGE_MS = 5 * 60_000;

export function signSync(secret: string, now = Date.now()) {
  const ts = String(now);
  return `${ts}.${createHmac("sha256", secret).update(`sync:${ts}`).digest("hex")}`;
}

export function verifySync(header: string | null) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const [ts, signature] = (header ?? "").split(".");
  if (!secret || !ts || !signature) return false;
  if (Math.abs(Date.now() - Number(ts)) > MAX_AGE_MS) return false;
  const expected = createHmac("sha256", secret).update(`sync:${ts}`).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
