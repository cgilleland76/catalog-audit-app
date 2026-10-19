// Plan names must match the plans set up in Shopify App Pricing (Dev
// Dashboard → the app → Pricing), since Shopify reports the active plan by name.
export type PlanId = "free" | "pro" | "warehouse";

export const PLANS: Record<
  PlanId,
  { name: string; price: string; features: string[] }
> = {
  free: {
    name: "Free",
    price: "$0",
    features: ["Catalog audit for up to 500 variants"],
  },
  pro: {
    name: "Pro",
    price: "$14.99/month",
    features: ["Catalog audit for up to 10,000 variants", "Wholesale line sheets"],
  },
  warehouse: {
    name: "Warehouse",
    price: "$39/month",
    features: [
      "Everything in Pro, for up to 100,000 variants",
      "Warehouse comparison (ShipHero, more coming)",
      "Fix in Shopify with Undo",
      "Scheduled sync",
      "History of every change",
    ],
  },
};

export const FREE_VARIANT_LIMIT = 500;

/**
 * Active and draft variants each plan covers (archived products are ignored).
 * Larger catalogs are audited, compared and listed up to the limit.
 */
export const VARIANT_LIMIT: Record<PlanId, number> = {
  free: FREE_VARIANT_LIMIT,
  pro: 10_000,
  warehouse: 100_000,
};

export const canUseLineSheets = (plan: PlanId) => plan !== "free";
export const canUseWarehouse = (plan: PlanId) => plan === "warehouse";
