import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deleteShopData } from "../lib/shop-data.server";
import { webhookAuthWithoutToken } from "../lib/webhook-auth";

// Shopify's mandatory privacy webhooks. SKU Doctor stores no customer data,
// so customer requests have nothing to return or delete; shop/redact (sent
// 48 hours after uninstall) removes anything left for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await webhookAuthWithoutToken(authenticate.webhook)(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // The library reports topics as e.g. "SHOP_REDACT"; normalize just in case.
  if (topic.toUpperCase().replace("/", "_") === "SHOP_REDACT") {
    // Reinstalled since it was uninstalled: the store is using its data again.
    if (await db.session.count({ where: { shop } })) {
      console.log(`${shop} has reinstalled the app; keeping its data`);
    } else {
      await deleteShopData(shop);
    }
  }

  return new Response();
};
