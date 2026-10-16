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

// The plan rarely changes, and each instance serves few shops; a short cache
// saves a GraphQL call on every page load.
const cache = new Map<string, { plan: PlanId; at: number }>();
const CACHE_MS = 60_000;

/**
 * The dev app has no App Store pricing; its site sets PLAN_OVERRIDE (e.g.
 * "warehouse") to unlock features for testing. Never set it on the public site.
 */
export function planOverride(): PlanId | null {
  const value = process.env.PLAN_OVERRIDE?.trim().toLowerCase();
  return value === "free" || value === "pro" || value === "warehouse" ? value : null;
}

/** The shop's current SKU Doctor plan, from its active Shopify App Pricing subscription. */
export async function getPlan(
  shop: string,
  admin: AdminApiContext,
): Promise<PlanId> {
  const override = planOverride();
  if (override) return override;

  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.plan;

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

  const plan: PlanId = names.some((n) => n.includes("warehouse"))
    ? "warehouse"
    : names.some((n) => n.includes("pro"))
      ? "pro"
      : "free";
  cache.set(shop, { plan, at: Date.now() });
  return plan;
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
