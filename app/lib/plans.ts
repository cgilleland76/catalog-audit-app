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
    features: ["Unlimited catalog audit", "Wholesale line sheets"],
  },
  warehouse: {
    name: "Warehouse",
    price: "$39/month",
    features: [
      "Everything in Pro",
      "Warehouse comparison (ShipHero, more coming)",
      "Fix in Shopify with Undo",
      "Scheduled sync",
      "History of every change",
    ],
  },
};

export const FREE_VARIANT_LIMIT = 500;

export const canUseLineSheets = (plan: PlanId) => plan !== "free";
export const canUseWarehouse = (plan: PlanId) => plan === "warehouse";
