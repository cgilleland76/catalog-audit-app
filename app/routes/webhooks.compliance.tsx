import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { deleteShopData } from "../lib/shop-data.server";

// Shopify's mandatory privacy webhooks. SKU Doctor stores no customer data,
// so customer requests have nothing to return or delete; shop/redact (sent
// 48 hours after uninstall) removes anything left for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // The library reports topics as e.g. "SHOP_REDACT"; normalize just in case.
  if (topic.toUpperCase().replace("/", "_") === "SHOP_REDACT") {
    await deleteShopData(shop);
  }

  return new Response();
};
