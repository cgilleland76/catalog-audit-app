import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import type { CatalogRow, ScanState } from "./catalog";

// The catalog is read with a bulk operation: Shopify exports every variant to
// a JSONL file in the background, so catalog size never makes a page wait.
const BULK_QUERY = `{
  productVariants {
    edges {
      node {
        id
        title
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
        inventoryItem {
          requiresShipping
          unitCost {
            amount
          }
          measurement {
            weight {
              value
              unit
            }
          }
        }
        product {
          id
          title
          handle
          status
          vendor
          productType
          tags
          featuredMedia {
            preview {
              image {
                url(transform: { maxWidth: 400, maxHeight: 400 })
              }
            }
          }
        }
      }
    }
  }
}`;

const RUN_BULK = `#graphql
  mutation RunCatalogExport($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BULK_STATUS = `#graphql
  query CatalogExportStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        url
      }
    }
  }
`;

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    requiresShipping: boolean;
    unitCost: { amount: string } | null;
    measurement: { weight: { value: number; unit: string } | null } | null;
  } | null;
  product: {
    id: string;
    title: string;
    handle: string;
    status: string;
    vendor: string;
    productType: string;
    tags: string[];
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  } | null;
};

const toNumber = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? null : Number(value);

export function toRow(v: VariantNode): CatalogRow | null {
  if (!v.product) return null;
  const weight = v.inventoryItem?.measurement?.weight ?? null;
  return {
    variantId: v.id,
    variantTitle: v.title,
    productId: v.product.id,
    productTitle: v.product.title,
    handle: v.product.handle,
    status: v.product.status,
    vendor: v.product.vendor,
    productType: v.product.productType,
    tags: v.product.tags,
    imageUrl: v.product.featuredMedia?.preview?.image?.url ?? null,
    sku: v.sku?.trim() || null,
    barcode: v.barcode?.trim() || null,
    price: toNumber(v.price) ?? 0,
    compareAtPrice: toNumber(v.compareAtPrice),
    cost: toNumber(v.inventoryItem?.unitCost?.amount),
    weight: weight ? weight.value : null,
    weightUnit: weight ? weight.unit : null,
    requiresShipping: v.inventoryItem?.requiresShipping ?? true,
    inventoryQuantity: v.inventoryQuantity,
  };
}

export function parseJsonl(text: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = toRow(JSON.parse(line) as VariantNode);
    if (row) rows.push(row);
  }
  return rows;
}

type ScanRecord = Awaited<ReturnType<typeof prisma.catalogScan.findFirst>>;

const toState = (s: NonNullable<ScanRecord>): ScanState => ({
  id: s.id,
  status: s.status as ScanState["status"],
  objectCount: s.objectCount,
  rowCount: s.rowCount,
  error: s.error,
  startedAt: s.startedAt.toISOString(),
  finishedAt: s.finishedAt?.toISOString() ?? null,
});

const fail = (id: string, error: string) =>
  prisma.catalogScan.update({
    where: { id },
    data: { status: "failed", error, finishedAt: new Date() },
  });

// Scans whose status is being checked right now in this instance, so two
// callers don't download the same file twice. Scans advance only when a page
// checks on them (serverless functions can't keep working in the background).
const checking = new Set<string>();

/** Checks a running scan's bulk operation and saves the rows once it's done. */
async function refresh(scanId: string, admin: AdminApiContext) {
  if (checking.has(scanId)) return;
  checking.add(scanId);
  try {
    const scan = await prisma.catalogScan.findUnique({ where: { id: scanId } });
    if (!scan || scan.status !== "running" || !scan.bulkOperationId) return;

    const response = await admin.graphql(BULK_STATUS, {
      variables: { id: scan.bulkOperationId },
    });
    const json = (await response.json()) as {
      data?: {
        node: {
          status: string;
          errorCode: string | null;
          objectCount: string;
          url: string | null;
        } | null;
      };
    };
    const op = json.data?.node;
    if (!op) return fail(scan.id, "Shopify lost track of the export; scan again");

    const objectCount = Number(op.objectCount) || 0;
    if (op.status === "CREATED" || op.status === "RUNNING") {
      await prisma.catalogScan.update({
        where: { id: scan.id },
        data: { objectCount },
      });
      return;
    }
    if (op.status !== "COMPLETED") {
      return fail(
        scan.id,
        `Shopify export ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}`,
      );
    }

    // No URL means the shop has no variants.
    const rows = op.url ? parseJsonl(await (await fetch(op.url)).text()) : [];
    await prisma.catalogScan.update({
      where: { id: scan.id },
      data: {
        status: "done",
        objectCount,
        rowCount: rows.length,
        rows: JSON.stringify(rows),
        finishedAt: new Date(),
      },
    });
    // Keep only the latest finished scan's rows.
    await prisma.catalogScan.deleteMany({
      where: { shop: scan.shop, id: { not: scan.id }, status: { not: "running" } },
    });
  } catch (error) {
    await fail(scanId, error instanceof Error ? error.message : String(error));
  } finally {
    checking.delete(scanId);
  }
}

export async function startScan(shop: string, admin: AdminApiContext) {
  const running = await prisma.catalogScan.findFirst({
    where: { shop, status: "running" },
  });
  if (running) return toState(running);

  const response = await admin.graphql(RUN_BULK, {
    variables: { query: BULK_QUERY },
  });
  const json = (await response.json()) as {
    data?: {
      bulkOperationRunQuery: {
        bulkOperation: { id: string } | null;
        userErrors: { message: string }[];
      };
    };
  };
  const result = json.data?.bulkOperationRunQuery;
  const scan = await prisma.catalogScan.create({
    data: result?.bulkOperation
      ? { shop, status: "running", bulkOperationId: result.bulkOperation.id }
      : {
          shop,
          status: "failed",
          error:
            result?.userErrors.map((e) => e.message).join("; ") ||
            "Shopify didn't start the export",
          finishedAt: new Date(),
        },
  });
  return toState(scan);
}

/** Latest scan of any status, after checking on it if it's still running. */
export async function getScanState(
  shop: string,
  admin: AdminApiContext,
): Promise<ScanState | null> {
  let scan = await prisma.catalogScan.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });
  if (scan?.status === "running") {
    await refresh(scan.id, admin);
    scan = await prisma.catalogScan.findUnique({ where: { id: scan.id } });
  }
  return scan ? toState(scan) : null;
}

/** Rows from the latest finished scan, or null if there isn't one yet. */
export async function loadCatalog(shop: string) {
  const scan = await prisma.catalogScan.findFirst({
    where: { shop, status: "done" },
    orderBy: { startedAt: "desc" },
  });
  if (!scan?.rows) return null;
  return {
    rows: JSON.parse(scan.rows) as CatalogRow[],
    scannedAt: (scan.finishedAt ?? scan.startedAt).toISOString(),
  };
}

/**
 * What every page's loader needs: the latest rows (if any) and the scan
 * status. Starts the first scan automatically.
 */
export async function catalogForPage(shop: string, admin: AdminApiContext) {
  let scan = await getScanState(shop, admin);
  if (!scan) scan = await startScan(shop, admin);
  const catalog = await loadCatalog(shop);
  return {
    rows: catalog?.rows ?? null,
    scannedAt: catalog?.scannedAt ?? null,
    scan,
  };
}
