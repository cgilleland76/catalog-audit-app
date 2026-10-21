// Billing through Shopify App Pricing, read the same way as B2B-Sync.
//
// BILLING=shopify turns it on (the public site). Without it (the Dev site)
// every store gets PLAN_OVERRIDE, or Warehouse, and nothing here calls Shopify.
//
// Plans, prices and trials live in the Partner Dashboard; Shopify hosts the
// plan selection page. Which plan a store is on comes from the Partner API's
// activeSubscription query (the Admin API doesn't have it).

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import type { PlanId } from "./plans";

const PARTNER_API_VERSION = "2026-07";
// How long a looked-up plan is reused. Shopify has no webhooks for plan
// changes, so a cancellation is noticed when the cached answer expires.
const ACTIVE_TTL_MS = 5 * 60_000;
const NONE_TTL_MS = 60_000;
// If Shopify can't be reached, a plan seen this recently still counts
const STALE_OK_MS = 24 * 60 * 60_000;

export function billingEnabled(): boolean {
  return process.env.BILLING === "shopify";
}

/**
 * A fixed plan for testing: the Dev site sets PLAN_OVERRIDE=warehouse. Never
 * set it on the public site.
 */
export function planOverride(): PlanId | null {
  const value = process.env.PLAN_OVERRIDE?.trim().toLowerCase();
  return value === "free" || value === "pro" || value === "warehouse" ? value : null;
}

/** The SKU Doctor plan for a subscription's item handles (e.g. "warehouse"). */
export function planFromHandles(handles: string[]): PlanId {
  const lower = handles.map((h) => h.toLowerCase());
  if (lower.some((h) => h.includes("warehouse"))) return "warehouse";
  if (lower.some((h) => h.includes("pro"))) return "pro";
  return "free";
}

type Row = Awaited<ReturnType<typeof prisma.shopPlan.findUnique>>;

const toPlan = (row: NonNullable<Row>): PlanId =>
  row.handles === null ? "free" : planFromHandles(row.handles.split(",").filter(Boolean));

/**
 * The shop's current SKU Doctor plan. `fresh` skips the cache (after Shopify
 * sends the merchant back from the plan selection page). A store with no
 * subscription is on Free.
 */
export async function getPlan(
  shop: string,
  admin: AdminApiContext,
  { fresh = false } = {},
): Promise<PlanId> {
  const override = planOverride();
  if (override) return override;
  if (!billingEnabled()) return "warehouse";

  const row = await prisma.shopPlan.findUnique({ where: { shop } });
  const age = row?.checkedAt ? Date.now() - row.checkedAt.getTime() : Infinity;
  if (row && !fresh && age < (row.handles === null ? NONE_TTL_MS : ACTIVE_TTL_MS)) {
    return toPlan(row);
  }

  try {
    const shopGid = row?.shopGid ?? (await fetchShopGid(admin));
    const sub = await fetchActiveSubscription(shopGid);
    const data = {
      shopGid,
      handles: sub ? sub.handles.join(",") : null,
      trialEndsAt: sub?.trialEndsAt ? new Date(sub.trialEndsAt) : null,
      checkedAt: new Date(),
    };
    const saved = await prisma.shopPlan.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });
    return toPlan(saved);
  } catch (error) {
    if (row && row.handles !== null && age < STALE_OK_MS) {
      console.warn(
        `[billing] plan check failed for ${shop}; using the plan seen ${Math.round(age / 60_000)} min ago:`,
        error,
      );
      return toPlan(row);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't check this store's plan with Shopify. Try again in a minute. (${message})`);
  }
}

/**
 * Shopify-hosted page where merchants pick or change their plan. Opened in the
 * top window, since it's outside the embedded app. SHOPIFY_APP_HANDLE must be
 * the app's handle (sku-doctor-app for public).
 */
export function planSelectionUrl(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "sku-doctor-app";
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

// ---------------------------------------------------------------------------
// Shopify calls
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

async function fetchShopGid(admin: AdminApiContext): Promise<string> {
  const res = await admin.graphql(`#graphql
    query ShopId { shop { id } }`);
  const body = (await res.json()) as { data?: { shop?: { id?: string } } };
  const id = body.data?.shop?.id;
  if (!id) throw new Error("Shopify didn't return this store's id.");
  return id;
}

/** The store's subscription to this app, or null when it has none. */
async function fetchActiveSubscription(
  shopGid: string,
): Promise<{ handles: string[]; trialEndsAt: string | null } | null> {
  const org = requiredEnv("SHOPIFY_PARTNER_ORG_ID");
  const appId = requiredEnv("SHOPIFY_APP_ID");
  const res = await fetch(
    `https://partners.shopify.com/${org}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": requiredEnv("SHOPIFY_PARTNER_API_TOKEN"),
      },
      body: JSON.stringify({
        query: `query ActiveSubscription($appId: ID!, $shopId: ID!) {
          activeSubscription(appId: $appId, shopId: $shopId) { trialEndsAt items { handle } }
        }`,
        variables: {
          appId: appId.startsWith("gid://") ? appId : `gid://shopify/App/${appId}`,
          shopId: shopGid,
        },
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    data?: {
      activeSubscription: { trialEndsAt: string | null; items: { handle: string }[] } | null;
    };
    errors?: { message: string }[];
  } | null;
  // Never read a failed request as "no plan": that would downgrade a paying store
  if (!res.ok || !body?.data || body.errors?.length) {
    throw new Error(
      `Partner API: ${body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`,
    );
  }
  const sub = body.data.activeSubscription;
  return sub ? { handles: sub.items.map((i) => i.handle), trialEndsAt: sub.trialEndsAt } : null;
}
