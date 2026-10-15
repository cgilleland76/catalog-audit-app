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
};

export interface WmsProvider extends WmsProviderInfo {
  /** Throws with a readable message if the credentials don't work. */
  testConnection(credentials: WmsCredentials): Promise<void>;
  /**
   * Looks up the given SKUs. Returns only the SKUs the WMS knows, keyed by
   * lower-cased SKU. `onProgress` reports how many SKUs have been checked.
   */
  fetchBySku(
    credentials: WmsCredentials,
    skus: string[],
    onProgress: (checked: number) => Promise<void> | void,
  ): Promise<Map<string, WmsProduct>>;
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
};
