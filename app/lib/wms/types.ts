// A warehouse product normalized to pounds, inches and the shop currency, so
// every WMS connector can be compared against Shopify the same way.
export type WmsProduct = {
  sku: string;
  name: string | null;
  barcode: string | null;
  weightLb: number | null;
  cost: number | null;
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

export type WmsProviderInfo = {
  id: string;
  name: string;
  credentialFields: CredentialField[];
  setupHelp: string;
  /** False when the warehouse system has no product cost to compare. */
  comparesCost: boolean;
  /** System-specific notes for the "How it compares" list. */
  compareNotes: string[];
};

export interface WmsProvider extends WmsProviderInfo {
  /** Throws with a readable message if the credentials don't work. */
  testConnection(credentials: WmsCredentials): Promise<void>;
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
  | "barcode_mismatch";

export const MISMATCH_INFO: Record<
  MismatchCode,
  { label: string; tone: "critical" | "warning" | "info" }
> = {
  weight_mismatch: { label: "Weight differs", tone: "critical" },
  cost_mismatch: { label: "Cost differs", tone: "warning" },
  barcode_mismatch: { label: "Barcode differs", tone: "warning" },
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
  /** The warehouse's value, for fixing Shopify: pounds, cost, or barcode. */
  target?: number | string;
};
