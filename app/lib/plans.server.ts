import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { PlanId } from "./plans";

const ACTIVE_SUBSCRIPTIONS = `#graphql
  query ActivePlan {
    currentAppInstallation {
      activeSubscriptions {
        name
        status
      }
    }
  }
`;

/**
 * The dev app has no App Store pricing; its site sets PLAN_OVERRIDE (e.g.
 * "warehouse") to unlock features for testing. Never set it on the public site.
 */
export function planOverride(): PlanId | null {
  const value = process.env.PLAN_OVERRIDE?.trim().toLowerCase();
  return value === "free" || value === "pro" || value === "warehouse" ? value : null;
}

/**
 * The shop's current SKU Doctor plan, from its active Shopify App Pricing
 * subscription. Asked on every use, not cached: right after a merchant changes
 * plan, the app must already show the new one (App Store requirement 1.2.3).
 */
export async function getPlan(
  shop: string,
  admin: AdminApiContext,
): Promise<PlanId> {
  const override = planOverride();
  if (override) return override;

  const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation: {
        activeSubscriptions: { name: string; status: string }[];
      };
    };
  };
  const names = (json.data?.currentAppInstallation.activeSubscriptions ?? [])
    .filter((s) => s.status === "ACTIVE")
    .map((s) => s.name.toLowerCase());

  return names.some((n) => n.includes("warehouse"))
    ? "warehouse"
    : names.some((n) => n.includes("pro"))
      ? "pro"
      : "free";
}

/**
 * Shopify-hosted page where merchants pick or change their plan. Opened in the
 * top window, since it's outside the embedded app. SHOPIFY_APP_HANDLE must be
 * the app's handle (sku-doctor-app for public, sku-doctor-dev for dev).
 */
export function planSelectionUrl(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "sku-doctor-app";
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
