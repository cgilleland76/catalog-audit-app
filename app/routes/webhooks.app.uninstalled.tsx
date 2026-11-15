import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../lib/shop-data.server";
import { webhookAuthWithoutToken } from "../lib/webhook-auth";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await webhookAuthWithoutToken(authenticate.webhook)(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Deleting everything the app stored for the shop keeps the privacy policy's
  // promise that uninstalling removes your data. It runs even when the session
  // is already gone (a repeat delivery, or a token that couldn't be renewed):
  // every step is a deleteMany, so running it twice is harmless.
  await deleteShopData(shop);

  return new Response();
};
