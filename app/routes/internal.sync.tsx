import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

import { runSync } from "../lib/sync.server";

// Called every few minutes by netlify/functions/scheduled-sync.mjs. The caller
// signs a timestamp with the app's API secret, so only it can start a run.
const MAX_AGE_MS = 5 * 60_000;

function verified(request: Request) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const [ts, signature] = (request.headers.get("x-sync-signature") ?? "").split(".");
  if (!secret || !ts || !signature) return false;
  if (Math.abs(Date.now() - Number(ts)) > MAX_AGE_MS) return false;
  const expected = createHmac("sha256", secret).update(`sync:${ts}`).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const loader = () => new Response("Method not allowed", { status: 405 });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!verified(request)) return new Response("Unauthorized", { status: 401 });
  const report = await runSync();
  return Response.json({ ran: report.length, report });
};
