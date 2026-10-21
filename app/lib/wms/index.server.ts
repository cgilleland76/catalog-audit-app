import prisma from "../../db.server";
import { decryptJson, encryptJson } from "../crypto.server";
import type { CatalogRow } from "../catalog";
import {
  latestCatalog,
  rowCap,
  scopeStatuses,
  skuKey,
  variantPage,
  type Scope,
} from "../catalog.server";
import { shiphero } from "./shiphero.server";
import { shipbob } from "./shipbob.server";
import { cin7 } from "./cin7.server";
import { veeqo } from "./veeqo.server";
import { MISMATCH_INFO } from "./types";
import type {
  Mismatch,
  MismatchCode,
  WmsProduct,
  WmsCredentials,
  WmsProvider,
  WmsProviderInfo,
} from "./types";

// Add new warehouse systems here.
export const PROVIDERS: Record<string, WmsProvider> = {
  [shiphero.id]: shiphero,
  [shipbob.id]: shipbob,
  [cin7.id]: cin7,
  [veeqo.id]: veeqo,
};

// Systems not yet tested with a real account. They're listed only where
// WMS_PREVIEW=1 (the Dev site), or for a shop that already connected one.
const UNTESTED = new Set(["shipbob"]);

export const isListed = (id: string, connected = false) =>
  connected || !UNTESTED.has(id) || process.env.WMS_PREVIEW === "1";

export function getProvider(id: string): WmsProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Response("Unknown warehouse system", { status: 404 });
  return provider;
}

export const providerInfo = (p: WmsProvider): WmsProviderInfo => ({
  id: p.id,
  name: p.name,
  credentialFields: p.credentialFields,
  setupHelp: p.setupHelp,
  comparesCost: p.comparesCost,
  compareNotes: p.compareNotes,
  choosesCostSource: !!p.costSources,
});

export async function loadCredentials(shop: string, provider: string) {
  const row = await prisma.wmsConnection.findUnique({
    where: { shop_provider: { shop, provider } },
  });
  return row ? decryptJson<WmsCredentials>(row.credentials) : null;
}

export async function saveCredentials(
  shop: string,
  provider: string,
  credentials: WmsCredentials,
) {
  const encrypted = encryptJson(credentials);
  await prisma.wmsConnection.upsert({
    where: { shop_provider: { shop, provider } },
    create: { shop, provider, credentials: encrypted },
    update: { credentials: encrypted },
  });
}

export async function deleteCredentials(shop: string, provider: string) {
  await prisma.wmsConnection.deleteMany({ where: { shop, provider } });
}

/** Pounds per Shopify weight unit. */
export const TO_LB: Record<string, number> = {
  POUNDS: 1,
  OUNCES: 1 / 16,
  GRAMS: 1 / 453.59237,
  KILOGRAMS: 2.20462262,
};

const cents = (n: number) => Math.round(n * 100);

export function compareRows(
  rows: CatalogRow[],
  found: Map<string, WmsProduct>,
  wmsName: string,
): Mismatch[] {
  const out: Mismatch[] = [];
  for (const r of rows) {
    if (!r.sku) continue;
    const label =
      r.variantTitle && r.variantTitle !== "Default Title"
        ? `${r.productTitle} — ${r.variantTitle}`
        : r.productTitle;
    const base = { variantId: r.variantId, productId: r.productId, label, sku: r.sku };
    const w = found.get(r.sku.trim().toLowerCase());

    if (!w) {
      out.push({ ...base, code: "not_in_wms", shopify: "Listed", wms: `Not found in ${wmsName}` });
      continue;
    }

    const shopifyLb =
      r.weight === null ? null : r.weight * (TO_LB[r.weightUnit ?? "POUNDS"] ?? 1);
    if (w.weightLb && w.weightLb > 0 && cents(shopifyLb ?? 0) !== cents(w.weightLb)) {
      out.push({
        ...base,
        code: "weight_mismatch",
        shopify: shopifyLb ? `${shopifyLb.toFixed(2)} lb` : "—",
        wms: `${w.weightLb.toFixed(2)} lb`,
        target: w.weightLb,
      });
    }

    if (w.cost && w.cost > 0 && cents(r.cost ?? 0) !== cents(w.cost)) {
      out.push({
        ...base,
        code: "cost_mismatch",
        shopify: r.cost === null ? "—" : `$${r.cost.toFixed(2)}`,
        wms: `$${w.cost.toFixed(2)}`,
        target: w.cost,
      });
    }

    if (r.barcode && w.barcode && r.barcode !== w.barcode) {
      out.push({
        ...base,
        code: "barcode_mismatch",
        shopify: r.barcode,
        wms: w.barcode,
        target: w.barcode,
      });
    }
  }
  return out;
}

/** Creates a comparison of the latest catalog scan; steps do the work. */
export async function createComparison(
  shop: string,
  provider: WmsProvider,
  scope: Scope,
  variantLimit: number,
) {
  const catalog = await latestCatalog(shop);
  if (!catalog) return null;
  const maxRowId = await rowCap(catalog.scanId, variantLimit);
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT "skuKey") AS count FROM "CatalogVariant"
    WHERE "scanId" = ${catalog.scanId} AND "skuKey" IS NOT NULL
      AND "status" = ANY(${scopeStatuses(scope)})
      AND "id" <= ${maxRowId ?? 9223372036854775807n}`;
  return prisma.wmsComparison.create({
    data: {
      shop,
      provider: provider.id,
      scanId: catalog.scanId,
      scope,
      status: "running",
      stage: "lookup",
      total: Number(count),
      maxRowId,
    },
  });
}

/** Distinct SKUs (original spelling) after `afterKey`, in key order. */
async function nextSkus(
  scanId: string,
  statuses: string[],
  afterKey: string | null,
  limit: number,
  maxId: bigint | null,
) {
  return prisma.$queryRaw<{ skuKey: string; sku: string }[]>`
    SELECT "skuKey", MIN("sku") AS sku FROM "CatalogVariant"
    WHERE "scanId" = ${scanId} AND "skuKey" IS NOT NULL
      AND "status" = ANY(${statuses}) AND "skuKey" > ${afterKey ?? ""}
      AND "id" <= ${maxId ?? 9223372036854775807n}
    GROUP BY "skuKey" ORDER BY "skuKey" LIMIT ${limit}`;
}

async function saveFound(comparisonId: string, found: WmsProduct[]) {
  if (!found.length) return;
  await prisma.wmsFound.createMany({
    data: found.map((p) => ({
      comparisonId,
      skuKey: p.sku.trim().toLowerCase(),
      data: JSON.stringify(p),
    })),
    skipDuplicates: true,
  });
}

// Each step must finish well inside the serverless request limit.
const STEP_MS = 6000;
const LOCK_MS = 15000;
const LOOKUP_BATCH = 500;
const COMPARE_BATCH = 2000;

/**
 * Runs the next few seconds of a comparison: looking SKUs up in the warehouse,
 * then comparing the catalog with what was found, a batch of variants at a
 * time. Safe to call from overlapping requests: only one step runs at a time.
 */
export async function advanceComparison(comparisonId: string) {
  const now = new Date();
  const claimed = await prisma.wmsComparison.updateMany({
    where: {
      id: comparisonId,
      status: "running",
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (claimed.count === 0) return;

  let c = await prisma.wmsComparison.findUniqueOrThrow({ where: { id: comparisonId } });
  const save = (data: Parameters<typeof prisma.wmsComparison.update>[0]["data"]) =>
    prisma.wmsComparison.update({ where: { id: comparisonId }, data });
  const deadline = Date.now() + STEP_MS;
  const statuses = scopeStatuses(c.scope);

  try {
    const provider = getProvider(c.provider);
    if (c.stage === "lookup") {
      const credentials = await loadCredentials(c.shop, c.provider);
      if (!credentials) {
        await save({ status: "failed", error: `${provider.name} is disconnected`, finishedAt: new Date(), lockedUntil: null });
        return;
      }
      if (provider.pagesCatalog) {
        // The provider pages its own catalog and needs every SKU to match against.
        const all = await nextSkus(c.scanId, statuses, null, 10_000_000, c.maxRowId);
        const result = await provider.lookup(credentials, all.map((r) => r.sku), deadline, c.cursor);
        await saveFound(c.id, result.found);
        const done = !result.cursor;
        c = await save({
          cursor: result.cursor ?? null,
          checked: done ? c.total : c.checked,
          ...(done ? { stage: "compare", rowCursor: 0n } : {}),
        });
      } else {
        while (c.checked < c.total && Date.now() + 1500 < deadline) {
          const batch = await nextSkus(c.scanId, statuses, c.skuCursor, LOOKUP_BATCH, c.maxRowId);
          if (!batch.length) break;
          const result = await provider.lookup(credentials, batch.map((r) => r.sku), deadline, null);
          await saveFound(c.id, result.found);
          if (result.processed === 0) break;
          c = await save({
            checked: c.checked + result.processed,
            skuCursor: batch[result.processed - 1].skuKey,
          });
          if (result.processed < batch.length) break; // out of time inside lookup
        }
        const remaining = await nextSkus(c.scanId, statuses, c.skuCursor, 1, c.maxRowId);
        if (!remaining.length) {
          c = await save({ checked: c.total, stage: "compare", rowCursor: 0n });
        }
      }
    }

    while (c.stage === "compare" && Date.now() + 1500 < deadline) {
      const rows = await variantPage(c.scanId, {
        after: c.rowCursor,
        size: COMPARE_BATCH,
        statuses,
        maxId: c.maxRowId,
      });
      if (!rows.length) {
        await save({ status: "done", finishedAt: new Date(), lockedUntil: null });
        return;
      }
      const keys = [...new Set(rows.map((r) => skuKey(r.sku)).filter((k): k is string => !!k))];
      const found = await prisma.wmsFound.findMany({
        where: { comparisonId: c.id, skuKey: { in: keys } },
      });
      const map = new Map(found.map((f) => [f.skuKey, JSON.parse(f.data) as WmsProduct]));
      const mismatches = compareRows(rows, map, provider.name);
      await prisma.$transaction([
        prisma.wmsMismatch.createMany({
          data: mismatches.map((m) => ({
            comparisonId: c.id,
            shop: c.shop,
            code: m.code,
            variantId: m.variantId,
            productId: m.productId,
            label: m.label,
            sku: m.sku,
            shopify: m.shopify,
            wms: m.wms,
            target: m.target === undefined || m.target === null ? null : JSON.stringify(m.target),
          })),
        }),
        prisma.wmsComparison.update({
          where: { id: c.id },
          data: {
            rowCursor: rows[rows.length - 1].rowId,
            mismatchCount: { increment: mismatches.length },
          },
        }),
      ]);
      c = await prisma.wmsComparison.findUniqueOrThrow({ where: { id: c.id } });
    }
    await save({ lockedUntil: null });
  } catch (error) {
    await save({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
      lockedUntil: null,
    });
  }
}

/** Removes a comparison's lookup data once it's no longer needed. */
export async function clearLookups(comparisonId: string) {
  await prisma.wmsFound.deleteMany({ where: { comparisonId } });
}

/** Counts of differences by issue, and how many of each can be fixed. */
export async function mismatchCounts(comparisonId: string) {
  const groups = await prisma.wmsMismatch.groupBy({
    by: ["code"],
    where: { comparisonId },
    _count: true,
  });
  const fixable = await prisma.wmsMismatch.groupBy({
    by: ["code"],
    where: { comparisonId, target: { not: null } },
    _count: true,
  });
  const count = (list: typeof groups, code: string) =>
    list.find((g) => g.code === code)?._count ?? 0;
  return Object.fromEntries(
    (Object.keys(MISMATCH_INFO) as MismatchCode[]).map((code) => [
      code,
      { total: count(groups, code), fixable: count(fixable, code) },
    ]),
  ) as Record<MismatchCode, { total: number; fixable: number }>;
}

/** A page of a comparison's differences, optionally of one issue. */
export async function mismatchPage(
  comparisonId: string,
  opts: { code?: MismatchCode | null; take: number; fixableOnly?: boolean; codes?: MismatchCode[] },
) {
  const page = (code: object, take: number) =>
    prisma.wmsMismatch.findMany({
      where: { comparisonId, ...code, ...(opts.fixableOnly ? { target: { not: null } } : {}) },
      orderBy: { id: "asc" },
      take,
    });
  let rows;
  if (opts.code || opts.codes) {
    rows = await page(opts.code ? { code: opts.code } : { code: { in: opts.codes } }, opts.take);
  } else {
    // Value differences (which can be fixed) before SKUs missing from the warehouse.
    rows = await page({ code: { not: "not_in_wms" } }, opts.take);
    if (rows.length < opts.take) {
      rows = rows.concat(await page({ code: "not_in_wms" }, opts.take - rows.length));
    }
  }
  return rows.map((m) => ({
    code: m.code as MismatchCode,
    variantId: m.variantId,
    productId: m.productId,
    label: m.label,
    sku: m.sku,
    shopify: m.shopify,
    wms: m.wms,
    target: m.target === null ? undefined : (JSON.parse(m.target) as number | string),
  })) satisfies Mismatch[];
}
