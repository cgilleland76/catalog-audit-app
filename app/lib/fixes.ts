import type { Mismatch, MismatchCode } from "./wms/types";

// Shared by the fix and sync server code and the Warehouse page.

export type FixField = "weight" | "cost" | "barcode" | "dimensions";
export const FIX_FIELDS: FixField[] = ["weight", "cost", "barcode", "dimensions"];

export const FIELD_OF: Partial<Record<MismatchCode, FixField>> = {
  weight_mismatch: "weight",
  cost_mismatch: "cost",
  barcode_mismatch: "barcode",
  dimensions_mismatch: "dimensions",
};

export const FIELD_LABEL: Record<FixField, string> = {
  weight: "Weight",
  cost: "Cost",
  barcode: "Barcode",
  dimensions: "Dimensions",
};

/** Batches older than this can no longer be undone and are deleted. */
export const UNDO_DAYS = 90;

/** One fixable difference, or null when the warehouse has nothing to copy. */
export function fixableField(m: Mismatch): FixField | null {
  const field = FIELD_OF[m.code];
  return field && m.target !== undefined && m.target !== null && m.target !== "" ? field : null;
}

export function fixCounts(results: Mismatch[]) {
  const counts: Record<FixField, number> = { weight: 0, cost: 0, barcode: 0, dimensions: 0 };
  for (const m of results) {
    const field = fixableField(m);
    if (field) counts[field]++;
  }
  return counts;
}

/** How often a scheduled sync runs. */
export const FREQUENCIES = {
  "6h": { label: "Every 6 hours", hours: 6 },
  daily: { label: "Daily", hours: 24 },
  weekly: { label: "Weekly", hours: 24 * 7 },
} as const;
export type Frequency = keyof typeof FREQUENCIES;
