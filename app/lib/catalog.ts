// Shared types and pure helpers, safe to import from browser code.

export type CatalogRow = {
  variantId: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  imageUrl: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  compareAtPrice: number | null;
  cost: number | null;
  weight: number | null;
  weightUnit: string | null;
  requiresShipping: boolean;
  inventoryQuantity: number | null;
};

export type ScanState = {
  id: string;
  status: "running" | "done" | "failed";
  objectCount: number;
  rowCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type IssueSeverity = "critical" | "warning" | "info";

export type IssueCode =
  | "missing_sku"
  | "duplicate_sku"
  | "missing_barcode"
  | "duplicate_barcode"
  | "missing_weight"
  | "missing_cost"
  | "price_below_cost"
  | "low_margin"
  | "zero_price"
  | "compare_at_not_higher"
  | "missing_image";

export const ISSUE_INFO: Record<
  IssueCode,
  { label: string; severity: IssueSeverity }
> = {
  price_below_cost: { label: "Price below cost", severity: "critical" },
  zero_price: { label: "Price is $0", severity: "critical" },
  duplicate_sku: { label: "Duplicate SKU", severity: "critical" },
  missing_weight: { label: "Missing weight", severity: "critical" },
  missing_sku: { label: "Missing SKU", severity: "warning" },
  missing_cost: { label: "Missing cost", severity: "warning" },
  low_margin: { label: "Low margin", severity: "warning" },
  duplicate_barcode: { label: "Duplicate barcode", severity: "warning" },
  compare_at_not_higher: {
    label: "Compare-at price not above price",
    severity: "warning",
  },
  missing_barcode: { label: "Missing barcode", severity: "info" },
  missing_image: { label: "Missing image", severity: "info" },
};

export type Issue = {
  code: IssueCode;
  detail: string;
};

export type AuditOptions = {
  minMarginPercent: number;
  includeDrafts: boolean;
  includeArchived: boolean;
};

export type AuditedRow = CatalogRow & { issues: Issue[]; margin: number | null };

export const marginPercent = (price: number, cost: number | null) =>
  cost === null || price <= 0 ? null : ((price - cost) / price) * 100;

const money = (n: number) => `$${n.toFixed(2)}`;

export function auditCatalog(
  allRows: CatalogRow[],
  options: AuditOptions,
): AuditedRow[] {
  const rows = allRows.filter(
    (r) =>
      r.status === "ACTIVE" ||
      (options.includeDrafts && r.status === "DRAFT") ||
      (options.includeArchived && r.status === "ARCHIVED"),
  );

  const countBy = (key: (r: CatalogRow) => string | null) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = key(r)?.toLowerCase();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const skuCounts = countBy((r) => r.sku);
  const barcodeCounts = countBy((r) => r.barcode);

  return rows.map((r) => {
    const issues: Issue[] = [];
    const margin = marginPercent(r.price, r.cost);

    if (!r.sku) issues.push({ code: "missing_sku", detail: "No SKU" });
    else if ((skuCounts.get(r.sku.toLowerCase()) ?? 0) > 1)
      issues.push({
        code: "duplicate_sku",
        detail: `${r.sku} used on ${skuCounts.get(r.sku.toLowerCase())} variants`,
      });

    if (!r.barcode)
      issues.push({ code: "missing_barcode", detail: "No barcode / UPC" });
    else if ((barcodeCounts.get(r.barcode.toLowerCase()) ?? 0) > 1)
      issues.push({
        code: "duplicate_barcode",
        detail: `${r.barcode} used on ${barcodeCounts.get(r.barcode.toLowerCase())} variants`,
      });

    if (r.requiresShipping && (r.weight === null || r.weight <= 0))
      issues.push({
        code: "missing_weight",
        detail: "Ships, but weight is 0 — shipping rates will be wrong",
      });

    if (r.price <= 0)
      issues.push({ code: "zero_price", detail: "Selling price is $0" });

    if (r.cost === null)
      issues.push({ code: "missing_cost", detail: "No cost per item" });
    else if (r.price > 0 && r.price < r.cost)
      issues.push({
        code: "price_below_cost",
        detail: `Price ${money(r.price)} < cost ${money(r.cost)}`,
      });
    else if (margin !== null && margin < options.minMarginPercent)
      issues.push({
        code: "low_margin",
        detail: `${margin.toFixed(1)}% margin (target ${options.minMarginPercent}%)`,
      });

    if (r.compareAtPrice !== null && r.compareAtPrice > 0 && r.compareAtPrice <= r.price)
      issues.push({
        code: "compare_at_not_higher",
        detail: `Compare-at ${money(r.compareAtPrice)} ≤ price ${money(r.price)}`,
      });

    if (!r.imageUrl)
      issues.push({ code: "missing_image", detail: "Product has no image" });

    return { ...r, issues, margin };
  });
}

export function toCsv(header: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}

export function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const variantLabel = (r: CatalogRow) =>
  r.variantTitle && r.variantTitle !== "Default Title"
    ? `${r.productTitle} — ${r.variantTitle}`
    : r.productTitle;

export const numericId = (gid: string) => gid.split("/").pop() ?? gid;
