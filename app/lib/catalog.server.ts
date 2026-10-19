import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import type { CatalogRow, ScanState } from "./catalog";

// The catalog is read with a bulk operation: Shopify exports every active and
// draft variant to a JSONL file in the background (archived products are
// ignored), then the file is imported a few megabytes per step into
// CatalogVariant, so catalog size never makes a request run long.
const BULK_QUERY = `{
  productVariants(query: "product_status:active OR product_status:draft") {
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
        fileSize
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

type ScanRecord = NonNullable<Awaited<ReturnType<typeof prisma.catalogScan.findFirst>>>;
type VariantRecord = Awaited<ReturnType<typeof prisma.catalogVariant.findMany>>[number];

const toState = (s: ScanRecord): ScanState => ({
  id: s.id,
  status: s.status as ScanState["status"],
  objectCount: s.objectCount,
  rowCount: s.rowCount,
  progress:
    s.status === "importing" && Number(s.fileSize) > 0
      ? Math.min(1, Number(s.importOffset) / Number(s.fileSize))
      : null,
  error: s.error,
  startedAt: s.startedAt.toISOString(),
  finishedAt: s.finishedAt?.toISOString() ?? null,
});

const fail = (id: string, error: string) =>
  prisma.catalogScan.update({
    where: { id },
    data: { status: "failed", error, url: null, lockedUntil: null, finishedAt: new Date() },
  });

export const skuKey = (sku: string | null | undefined) => sku?.trim().toLowerCase() || null;

/** A catalog row as stored in CatalogVariant. */
export const toVariantData = (shop: string, scanId: string, r: CatalogRow) => ({
  shop,
  scanId,
  variantId: r.variantId,
  variantTitle: r.variantTitle,
  productId: r.productId,
  productTitle: r.productTitle,
  handle: r.handle,
  status: r.status,
  vendor: r.vendor,
  productType: r.productType,
  tags: JSON.stringify(r.tags),
  imageUrl: r.imageUrl,
  sku: r.sku,
  skuKey: skuKey(r.sku),
  barcode: r.barcode,
  price: r.price,
  compareAtPrice: r.compareAtPrice,
  cost: r.cost,
  weight: r.weight,
  weightUnit: r.weightUnit,
  requiresShipping: r.requiresShipping,
  inventoryQuantity: r.inventoryQuantity,
});

export const variantRow = (v: VariantRecord): CatalogRow => ({
  variantId: v.variantId,
  variantTitle: v.variantTitle,
  productId: v.productId,
  productTitle: v.productTitle,
  handle: v.handle,
  status: v.status,
  vendor: v.vendor,
  productType: v.productType,
  tags: JSON.parse(v.tags) as string[],
  imageUrl: v.imageUrl,
  sku: v.sku,
  barcode: v.barcode,
  price: v.price,
  compareAtPrice: v.compareAtPrice,
  cost: v.cost,
  weight: v.weight,
  weightUnit: v.weightUnit,
  requiresShipping: v.requiresShipping,
  inventoryQuantity: v.inventoryQuantity,
});

export const fromVariant = (v: VariantRecord): CatalogRow & { rowId: bigint } => ({
  ...variantRow(v),
  rowId: v.id,
});

/**
 * With a plan limit of `limit` variants: the id of the last variant covered,
 * or null when the whole scan fits.
 */
export async function rowCap(scanId: string, limit: number): Promise<bigint | null> {
  const rows = await prisma.catalogVariant.findMany({
    where: { scanId },
    orderBy: { id: "asc" },
    skip: limit,
    take: 1,
    select: { id: true },
  });
  if (!rows.length) return null;
  const last = await prisma.catalogVariant.findMany({
    where: { scanId },
    orderBy: { id: "asc" },
    skip: limit - 1,
    take: 1,
    select: { id: true },
  });
  return last[0]?.id ?? null;
}

// Scans whose status is being checked right now in this instance, so two
// callers don't ask Shopify twice. Scans advance only when something checks on
// them (a page polling, or the scheduled sync).
const checking = new Set<string>();

/** Checks a running scan's bulk operation; starts the import once it's done. */
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
          fileSize: string | null;
          url: string | null;
        } | null;
      };
    };
    const op = json.data?.node;
    if (!op) return void (await fail(scan.id, "Shopify lost track of the export; scan again"));

    const objectCount = Number(op.objectCount) || 0;
    if (op.status === "CREATED" || op.status === "RUNNING") {
      await prisma.catalogScan.update({ where: { id: scan.id }, data: { objectCount } });
      return;
    }
    if (op.status !== "COMPLETED") {
      await fail(
        scan.id,
        `Shopify export ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}`,
      );
      return;
    }
    // No URL means the shop has no active or draft variants.
    await prisma.catalogScan.update({
      where: { id: scan.id },
      data: {
        status: "importing",
        objectCount,
        url: op.url,
        fileSize: BigInt(op.url ? Number(op.fileSize) || 0 : 0),
        importOffset: 0,
      },
    });
  } catch (error) {
    await fail(scanId, error instanceof Error ? error.message : String(error));
  } finally {
    checking.delete(scanId);
  }
}

// Each import step reads up to CHUNK_BYTES of the export at a time with an
// HTTP Range request, inserts the complete lines, and saves how far it got.
const CHUNK_BYTES = 4 * 1024 * 1024;
const INSERT_BATCH = 1000;
const STEP_MS = 6000;
const LOCK_MS = 20000;

/** Imports the next part of a scan's export file; finishes the scan at the end. */
export async function importStep(scanId: string) {
  const now = new Date();
  const claimed = await prisma.catalogScan.updateMany({
    where: {
      id: scanId,
      status: "importing",
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (claimed.count === 0) return;

  const scan = await prisma.catalogScan.findUniqueOrThrow({ where: { id: scanId } });
  const deadline = Date.now() + STEP_MS;
  const size = Number(scan.fileSize);
  let offset = Number(scan.importOffset);
  const decoder = new TextDecoder();

  try {
    while (scan.url && offset < size && Date.now() + 2500 < deadline) {
      const end = Math.min(offset + CHUNK_BYTES, size) - 1;
      const res = await fetch(scan.url, { headers: { range: `bytes=${offset}-${end}` } });
      if (!res.ok) {
        throw new Error(
          res.status === 403 || res.status === 410
            ? "The catalog export link expired; read the catalog again"
            : `Downloading the catalog export failed (${res.status})`,
        );
      }
      let bytes = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range sends the whole file.
      if (res.status === 200) bytes = bytes.subarray(offset, end + 1);
      const atEnd = end + 1 >= size;
      const take = atEnd ? bytes.length : bytes.lastIndexOf(10) + 1;
      if (take <= 0) throw new Error("A catalog line was too long to import");

      const rows = parseJsonl(decoder.decode(bytes.subarray(0, take)));
      const data = rows.map((r) => toVariantData(scan.shop, scan.id, r));
      const writes = [];
      for (let i = 0; i < data.length; i += INSERT_BATCH) {
        writes.push(prisma.catalogVariant.createMany({ data: data.slice(i, i + INSERT_BATCH) }));
      }
      offset += take;
      // Rows and progress are saved together, so a retried step never
      // imports the same lines twice.
      await prisma.$transaction([
        ...writes,
        prisma.catalogScan.update({
          where: { id: scan.id },
          data: { importOffset: BigInt(offset), rowCount: { increment: rows.length } },
        }),
      ]);
    }

    if (!scan.url || offset >= size) {
      await prisma.catalogScan.update({
        where: { id: scan.id },
        data: { status: "done", url: null, lockedUntil: null, finishedAt: new Date() },
      });
      // Keep only the latest finished scan.
      const old = await prisma.catalogScan.findMany({
        where: { shop: scan.shop, id: { not: scan.id }, status: { in: ["done", "failed"] } },
        select: { id: true },
      });
      const ids = old.map((o) => o.id);
      if (ids.length) {
        await prisma.catalogVariant.deleteMany({ where: { scanId: { in: ids } } });
        await prisma.catalogScan.deleteMany({ where: { id: { in: ids } } });
      }
      return;
    }
    await prisma.catalogScan.update({ where: { id: scan.id }, data: { lockedUntil: null } });
  } catch (error) {
    await prisma.catalogVariant.deleteMany({ where: { scanId: scan.id } });
    await fail(scan.id, error instanceof Error ? error.message : String(error));
  }
}

export async function startScan(shop: string, admin: AdminApiContext) {
  const active = await prisma.catalogScan.findFirst({
    where: { shop, status: { in: ["running", "importing"] } },
  });
  if (active) return toState(active);

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

/** Latest scan of any status, after moving it forward if it's in progress. */
export async function getScanState(
  shop: string,
  admin: AdminApiContext,
): Promise<ScanState | null> {
  let scan = await prisma.catalogScan.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });
  if (scan?.status === "running") await refresh(scan.id, admin);
  if (scan) scan = await prisma.catalogScan.findUnique({ where: { id: scan.id } });
  if (scan?.status === "importing") {
    await importStep(scan.id);
    scan = await prisma.catalogScan.findUnique({ where: { id: scan.id } });
  }
  return scan ? toState(scan) : null;
}

/** The latest finished scan, or null if there isn't one yet. */
export async function latestCatalog(shop: string) {
  const scan = await prisma.catalogScan.findFirst({
    where: { shop, status: "done" },
    orderBy: { startedAt: "desc" },
  });
  return scan
    ? {
        scanId: scan.id,
        count: scan.rowCount,
        scannedAt: (scan.finishedAt ?? scan.startedAt).toISOString(),
      }
    : null;
}

/** Product statuses a comparison or page covers. */
export type Scope = "active" | "active_draft";
export const scopeStatuses = (scope: string) =>
  scope === "active_draft" ? ["ACTIVE", "DRAFT"] : ["ACTIVE"];

/** Variants of a scan in id order, `size` at a time, starting after `after`. */
export async function variantPage(
  scanId: string,
  opts: {
    after?: bigint;
    size?: number;
    statuses?: string[];
    skuKeys?: string[];
    maxId?: bigint | null;
  } = {},
) {
  const rows = await prisma.catalogVariant.findMany({
    where: {
      scanId,
      id: { gt: opts.after ?? 0n, ...(opts.maxId ? { lte: opts.maxId } : {}) },
      ...(opts.statuses ? { status: { in: opts.statuses } } : {}),
      ...(opts.skuKeys ? { skuKey: { in: opts.skuKeys } } : {}),
    },
    orderBy: { id: "asc" },
    take: opts.size ?? 2000,
  });
  return rows.map(fromVariant);
}


/**
 * What every page's loader needs: the latest catalog (id, size, date) and the
 * scan status. Starts the first scan automatically.
 */
export async function catalogForPage(shop: string, admin: AdminApiContext) {
  let scan = await getScanState(shop, admin);
  if (!scan) scan = await startScan(shop, admin);
  const catalog = await latestCatalog(shop);
  return {
    scanId: catalog?.scanId ?? null,
    count: catalog?.count ?? null,
    scannedAt: catalog?.scannedAt ?? null,
    scan,
  };
}

/** A plan's variant limit for a scan: whether the catalog is over it, and the last row it covers. */
export async function planCap(scanId: string, count: number, limit: number) {
  const over = count > limit;
  return { limit, over, maxId: over ? await rowCap(scanId, limit) : null };
}
