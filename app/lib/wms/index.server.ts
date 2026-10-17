import prisma from "../../db.server";
import { decryptJson, encryptJson } from "../crypto.server";
import type { CatalogRow } from "../catalog";
import { shiphero } from "./shiphero.server";
import { shipbob } from "./shipbob.server";
import { cin7 } from "./cin7.server";
import { veeqo } from "./veeqo.server";
import type {
  Mismatch,
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

const TO_LB: Record<string, number> = {
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
      });
    }

    if (w.cost && w.cost > 0 && cents(r.cost ?? 0) !== cents(w.cost)) {
      out.push({
        ...base,
        code: "cost_mismatch",
        shopify: r.cost === null ? "—" : `$${r.cost.toFixed(2)}`,
        wms: `$${w.cost.toFixed(2)}`,
      });
    }

    if (r.barcode && w.barcode && r.barcode !== w.barcode) {
      out.push({ ...base, code: "barcode_mismatch", shopify: r.barcode, wms: w.barcode });
    }
  }
  return out;
}

/** Creates a comparison for every SKU in the catalog; steps do the work. */
export async function createComparison(
  shop: string,
  provider: WmsProvider,
  rows: CatalogRow[],
) {
  const skus = [
    ...new Set(rows.map((r) => r.sku?.trim()).filter((s): s is string => !!s)),
  ];
  return prisma.wmsComparison.create({
    data: {
      shop,
      provider: provider.id,
      status: "running",
      skus: JSON.stringify(skus),
      found: "{}",
      total: skus.length,
    },
  });
}

// Each step must finish well inside the serverless request limit.
const STEP_MS = 6000;
const LOCK_MS = 15000;

/**
 * Looks up the next SKUs for a running comparison and saves progress. When
 * every SKU is checked, compares against the latest catalog and finishes.
 * Safe to call from overlapping requests: only one step runs at a time.
 */
export async function advanceComparison(
  comparisonId: string,
  loadRows: () => Promise<CatalogRow[] | null>,
) {
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

  const comparison = await prisma.wmsComparison.findUniqueOrThrow({
    where: { id: comparisonId },
  });
  const finish = (data: Parameters<typeof prisma.wmsComparison.update>[0]["data"]) =>
    prisma.wmsComparison.update({
      where: { id: comparisonId },
      data: { ...data, lockedUntil: null },
    });

  try {
    const provider = getProvider(comparison.provider);
    const credentials = await loadCredentials(comparison.shop, comparison.provider);
    if (!credentials) {
      await finish({ status: "failed", error: `${provider.name} is disconnected`, finishedAt: new Date() });
      return;
    }

    const skus = JSON.parse(comparison.skus ?? "[]") as string[];
    const found = JSON.parse(comparison.found ?? "{}") as Record<string, WmsProduct>;
    let checked = comparison.checked;
    let cursor = comparison.cursor;

    if (checked < skus.length) {
      const result = await provider.lookup(
        credentials,
        skus.slice(checked),
        Date.now() + STEP_MS,
        cursor,
      );
      for (const p of result.found) found[p.sku.trim().toLowerCase()] = p;
      checked += result.processed;
      cursor = result.cursor ?? null;
    }

    if (checked < skus.length) {
      await finish({ checked, cursor, found: JSON.stringify(found) });
      return;
    }

    const rows = await loadRows();
    if (!rows) {
      await finish({ status: "failed", error: "No catalog scan to compare against", finishedAt: new Date() });
      return;
    }
    const mismatches = compareRows(
      rows.filter((r) => r.status !== "ARCHIVED"),
      new Map(Object.entries(found)),
      provider.name,
    );
    await finish({
      status: "done",
      checked,
      skus: null,
      found: null,
      cursor: null,
      results: JSON.stringify(mismatches),
      finishedAt: new Date(),
    });
  } catch (error) {
    await finish({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
    });
  }
}
