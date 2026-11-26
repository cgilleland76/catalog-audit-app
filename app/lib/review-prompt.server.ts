import db from "../db.server";
import { reviewPromptDueAt } from "./review-prompt.ts";

/** Whether SKU Doctor may ask Shopify to show its review modal to this shop now. */
export async function reviewPromptDue(shop: string, now = new Date()) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  return reviewPromptDueAt(settings?.lastReviewPromptAt, now);
}

/** Notes that the review modal was asked for (shown, or refused for a while). */
export async function recordReviewPrompt(shop: string, now = new Date()) {
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, lastReviewPromptAt: now },
    update: { lastReviewPromptAt: now },
  });
}
