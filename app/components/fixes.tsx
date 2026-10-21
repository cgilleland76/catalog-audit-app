import type { FixField } from "../lib/fixes";
import { formatDims, validDims, type Dims } from "../lib/dimensions";

// Labels and formatting for fix batches and changes, shared by the Warehouse
// and History pages.

export type FixBatchRow = {
  id: string;
  provider: string;
  source: string;
  status: string;
  total: number;
  applied: number;
  failed: number;
  reverted: number;
  kept: number;
  error: string | null;
  createdAt: string;
  undoable: number;
};

type Tone = "info" | "success" | "critical" | "neutral" | "warning";

export function fixStatus(b: FixBatchRow): { label: string; tone: Tone } {
  if (b.status === "applying") return { label: "Fixing…", tone: "info" };
  if (b.status === "undoing") return { label: "Undoing…", tone: "info" };
  if (b.status === "failed") return { label: "Failed", tone: "critical" };
  if (b.status === "undone") return { label: "Undone", tone: "neutral" };
  if (b.error) return { label: "Stopped early", tone: "warning" };
  if (b.reverted > 0) return { label: "Partly undone", tone: "warning" };
  return { label: "Fixed", tone: "success" };
}

export function fixSummary(b: FixBatchRow) {
  const n = (x: number) => x.toLocaleString();
  if (b.status === "applying") return `${n(b.applied)} of ${n(b.total)} done`;
  if (b.status === "undoing") return `${n(b.reverted)} restored so far`;
  if (b.status === "failed" && !b.applied) return b.error ?? "Stopped";
  const parts = [`${n(b.applied)} of ${n(b.total)} ${b.total === 1 ? "value" : "values"} set`];
  if (b.failed) parts.push(`${n(b.failed)} failed`);
  if (b.reverted) parts.push(`${n(b.reverted)} undone`);
  if (b.kept) parts.push(`${n(b.kept)} kept (changed in Shopify since)`);
  return parts.join(", ") + (b.error ? ` · ${b.error}` : "");
}

const UNIT: Record<string, string> = { POUNDS: "lb", OUNCES: "oz", GRAMS: "g", KILOGRAMS: "kg" };

/** A stored fix value (JSON) as text: "1.25 lb", "$4.50", a barcode, or "—". */
export function formatFixValue(field: FixField, raw: string | null): string {
  if (!raw) return "—";
  const value = JSON.parse(raw) as unknown;
  if (value === null || value === "") return "—";
  if (field === "weight" && typeof value === "object") {
    const w = value as { lb?: number; value?: number; unit?: string };
    if (typeof w.lb === "number") return `${w.lb.toFixed(2)} lb`;
    if (typeof w.value === "number") return w.value === 0 ? "—" : `${Number(w.value.toFixed(4))} ${UNIT[w.unit ?? ""] ?? w.unit ?? ""}`;
  }
  if (field === "cost" && typeof value === "number") return `$${value.toFixed(2)}`;
  if (field === "dimensions" && typeof value === "object") return formatDims(validDims(value as Dims));
  return String(value);
}

export const CHANGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "info" },
  writing: { label: "Saving…", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  unchanged: { label: "Already set", tone: "neutral" },
  failed: { label: "Failed", tone: "critical" },
  revert_pending: { label: "Undoing…", tone: "info" },
  reverted: { label: "Undone", tone: "neutral" },
  kept: { label: "Changed since", tone: "warning" },
  undo_failed: { label: "Undo failed", tone: "critical" },
};

export const hideModal = (id: string) =>
  (document.getElementById(id) as (HTMLElement & { hideOverlay?: () => void }) | null)?.hideOverlay?.();
