import prisma from "../db.server";
import { variantRow } from "./catalog.server";
import { ALL, type LineSheetFilters } from "./linesheet";

// Line sheet data, filtered on the server so a large catalog never goes to
// the browser whole. Only the variants matching the filters are sent.

/** Most variants one line sheet holds; past this, narrow the filters. */
export const LINE_SHEET_MAX = 5000;

export function lineSheetFilters(request: Request): LineSheetFilters {
  const url = new URL(request.url);
  return {
    vendor: url.searchParams.get("vendor") ?? ALL,
    productType: url.searchParams.get("type") ?? ALL,
    tag: url.searchParams.get("tag") ?? ALL,
    includeDrafts: url.searchParams.get("drafts") === "1",
    hideOutOfStock: url.searchParams.get("instock") === "1",
  };
}

const MAX_ID = 9223372036854775807n;

/** Vendors, product types and tags in the scan (within the plan's limit). */
export async function lineSheetOptions(scanId: string, maxId: bigint | null) {
  const max = maxId ?? MAX_ID;
  const [vendors, types, tags] = await Promise.all([
    prisma.$queryRaw<{ v: string }[]>`
      SELECT DISTINCT "vendor" AS v FROM "CatalogVariant"
      WHERE "scanId" = ${scanId} AND "id" <= ${max} AND "vendor" <> ''
      ORDER BY v LIMIT 2000`,
    prisma.$queryRaw<{ v: string }[]>`
      SELECT DISTINCT "productType" AS v FROM "CatalogVariant"
      WHERE "scanId" = ${scanId} AND "id" <= ${max} AND "productType" <> ''
      ORDER BY v LIMIT 2000`,
    prisma.$queryRaw<{ v: string }[]>`
      SELECT DISTINCT t AS v FROM "CatalogVariant",
        jsonb_array_elements_text("tags"::jsonb) AS t
      WHERE "scanId" = ${scanId} AND "id" <= ${max} AND t <> ''
      ORDER BY v LIMIT 2000`,
  ]);
  return {
    vendors: vendors.map((r) => r.v),
    types: types.map((r) => r.v),
    tags: tags.map((r) => r.v),
  };
}

/** Variants matching the filters, up to LINE_SHEET_MAX (`more` if there are others). */
export async function lineSheetRows(
  scanId: string,
  f: LineSheetFilters,
  maxId: bigint | null,
) {
  const rows = await prisma.catalogVariant.findMany({
    where: {
      scanId,
      ...(maxId ? { id: { lte: maxId } } : {}),
      status: { in: f.includeDrafts ? ["ACTIVE", "DRAFT"] : ["ACTIVE"] },
      ...(f.vendor !== ALL ? { vendor: f.vendor } : {}),
      ...(f.productType !== ALL ? { productType: f.productType } : {}),
      // Tags are stored as a JSON array, so a quoted tag matches one whole tag.
      ...(f.tag !== ALL ? { tags: { contains: JSON.stringify(f.tag) } } : {}),
      ...(f.hideOutOfStock ? { inventoryQuantity: { gt: 0 } } : {}),
    },
    orderBy: { id: "asc" },
    take: LINE_SHEET_MAX + 1,
  });
  return {
    rows: rows.slice(0, LINE_SHEET_MAX).map(variantRow),
    more: rows.length > LINE_SHEET_MAX,
  };
}
