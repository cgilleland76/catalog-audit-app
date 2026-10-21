import type { Dims } from "../dimensions";

// A warehouse product normalized to pounds, inches and the shop currency, so
// every WMS connector can be compared against Shopify the same way.
export type WmsProduct = {
  sku: string;
  name: string | null;
  barcode: string | null;
  weightLb: number | null;
  cost: number | null;
  /** Packed size in inches, for systems that compare dimensions. */
  dims?: Dims | null;
  isKit: boolean;
};

export type CredentialField = {
  key: string;
  label: string;
  helpText?: string;
  secret?: boolean;
  optional?: boolean;
};

export type WmsCredentials = Record<string, string>;

/**
 * Saved with the credentials: the warehouse whose cost to compare, for systems
 * that keep a cost per warehouse. Empty means the system's own product cost.
 */
export const COST_SOURCE_KEY = "costSource";

export type CostSource = { id: string; name: string };

export type WmsProviderInfo = {
  id: string;
  name: string;
  credentialFields: CredentialField[];
  setupHelp: string;
  /** False when the warehouse system has no product cost to compare. */
  comparesCost: boolean;
  /** System-specific notes for the "How it compares" list. */
  compareNotes: string[];
  /** True when the merchant can choose the warehouse cost comes from. */
  choosesCostSource: boolean;
  /** True when packed dimensions are compared (and dimensions are turned on). */
  comparesDimensions: boolean;
};

export interface WmsProvider
  extends Omit<WmsProviderInfo, "choosesCostSource" | "comparesDimensions"> {
  /** True when lookups return packed dimensions. */
  hasDimensions?: boolean;
  /**
   * True when lookup pages through the warehouse's whole catalog (it gets every
   * SKU at once and returns a cursor); false when it looks SKUs up in batches.
   */
  pagesCatalog: boolean;
  /** Throws with a readable message if the credentials don't work. */
  testConnection(credentials: WmsCredentials): Promise<void>;
  /** Warehouses that each keep their own cost, to choose from. */
  costSources?(credentials: WmsCredentials): Promise<CostSource[]>;
  /**
   * Looks up SKUs until `deadline` (a Date.now() timestamp) is near, so one
   * call fits in a serverless request. Returns the products found and how many
   * SKUs from the front of the list are done; the next step continues from
   * there. Systems that page through their whole catalog instead return a
   * `cursor` to resume from (and report SKUs done only once they finish).
   */
  lookup(
    credentials: WmsCredentials,
    skus: string[],
    deadline: number,
    cursor?: string | null,
  ): Promise<{ found: WmsProduct[]; processed: number; cursor?: string | null }>;
}

export type MismatchCode =
  | "not_in_wms"
  | "weight_mismatch"
  | "cost_mismatch"
  | "barcode_mismatch"
  | "dimensions_mismatch";

export const MISMATCH_INFO: Record<
  MismatchCode,
  { label: string; tone: "critical" | "warning" | "info" }
> = {
  weight_mismatch: { label: "Weight differs", tone: "critical" },
  cost_mismatch: { label: "Cost differs", tone: "warning" },
  barcode_mismatch: { label: "Barcode differs", tone: "warning" },
  dimensions_mismatch: { label: "Dimensions differ", tone: "warning" },
  not_in_wms: { label: "Not in warehouse", tone: "info" },
};

export type Mismatch = {
  code: MismatchCode;
  variantId: string;
  productId: string;
  label: string;
  sku: string;
  shopify: string;
  wms: string;
  /** The warehouse's value, for fixing Shopify: pounds, cost, barcode, or inches. */
  target?: number | string | Dims;
};
