import prisma from "../db.server";
import {
  auditRow,
  ISSUE_INFO,
  variantLabel,
  type AuditedRow,
  type IssueCode,
} from "./catalog";
import { scopeStatuses, variantPage } from "./catalog.server";

// The catalog audit, run on the server a batch of variants at a time so a
// large catalog never has to fit in one request's memory or the browser.

export type AuditFilters = {
  minMargin: number;
  includeDrafts: boolean;
  issue: IssueCode | "all";
  q: string;
  limit: number;
};

const ISSUE_CODES = Object.keys(ISSUE_INFO) as IssueCode[];

/** Lower-cased SKUs or barcodes used by more than one audited variant. */
async function duplicates(
  scanId: string,
  statuses: string[],
  maxId: bigint | null,
  column: "skuKey" | "barcode",
) {
  const max = maxId ?? 9223372036854775807n;
  const rows =
    column === "skuKey"
      ? await prisma.$queryRaw<{ key: string; n: bigint }[]>`
          SELECT "skuKey" AS key, COUNT(*) AS n FROM "CatalogVariant"
          WHERE "scanId" = ${scanId} AND "status" = ANY(${statuses}) AND "id" <= ${max}
            AND "skuKey" IS NOT NULL
          GROUP BY "skuKey" HAVING COUNT(*) > 1`
      : await prisma.$queryRaw<{ key: string; n: bigint }[]>`
          SELECT LOWER("barcode") AS key, COUNT(*) AS n FROM "CatalogVariant"
          WHERE "scanId" = ${scanId} AND "status" = ANY(${statuses}) AND "id" <= ${max}
            AND "barcode" IS NOT NULL AND "barcode" <> ''
          GROUP BY LOWER("barcode") HAVING COUNT(*) > 1`;
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/**
 * Audits a scan (up to `maxId` for plan limits): issue counts for the whole
 * catalog, plus up to `take` rows matching the filters. `take` rows are kept,
 * everything else only counted.
 */
export async function auditScan(
  scanId: string,
  filters: AuditFilters,
  opts: { maxId: bigint | null; take: number },
) {
  const statuses = scopeStatuses(filters.includeDrafts ? "active_draft" : "active");
  const [skus, barcodes] = await Promise.all([
    duplicates(scanId, statuses, opts.maxId, "skuKey"),
    duplicates(scanId, statuses, opts.maxId, "barcode"),
  ]);
  const ctx = {
    minMarginPercent: filters.minMargin,
    skuCount: (k: string) => skus.get(k) ?? 1,
    barcodeCount: (k: string) => barcodes.get(k) ?? 1,
  };

  const counts = Object.fromEntries(ISSUE_CODES.map((k) => [k, 0])) as Record<IssueCode, number>;
  let scanned = 0;
  let withIssues = 0;
  let critical = 0;
  let matching = 0;
  const rows: AuditedRow[] = [];
  const q = filters.q.trim().toLowerCase();

  let after = 0n;
  for (;;) {
    const page = await variantPage(scanId, { after, size: 5000, statuses, maxId: opts.maxId });
    if (!page.length) break;
    after = page[page.length - 1].rowId;
    for (const { rowId: _rowId, ...row } of page) {
      void _rowId;
      scanned++;
      const audited = auditRow(row, ctx);
      if (!audited.issues.length) continue;
      withIssues++;
      if (audited.issues.some((i) => ISSUE_INFO[i.code].severity === "critical")) critical++;
      for (const i of audited.issues) counts[i.code]++;

      const matches =
        (filters.issue === "all" || audited.issues.some((i) => i.code === filters.issue)) &&
        (!q ||
          variantLabel(row).toLowerCase().includes(q) ||
          (row.sku ?? "").toLowerCase().includes(q) ||
          row.vendor.toLowerCase().includes(q));
      if (!matches) continue;
      matching++;
      if (rows.length < opts.take) rows.push(audited);
    }
  }
  return { counts, scanned, withIssues, critical, matching, rows };
}
