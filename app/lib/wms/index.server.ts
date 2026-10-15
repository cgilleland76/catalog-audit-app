import prisma from "../../db.server";
import { decryptJson, encryptJson } from "../crypto.server";
import type { CatalogRow } from "../catalog";
import { shiphero } from "./shiphero.server";
import type {
  Mismatch,
  WmsCredentials,
  WmsProvider,
  WmsProviderInfo,
} from "./types";

// Add new warehouse systems here.
export const PROVIDERS: Record<string, WmsProvider> = {
  [shiphero.id]: shiphero,
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
  found: Map<string, import("./types").WmsProduct>,
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

// Comparisons running in this server process.
const active = new Set<string>();

// Runs after the request has returned; progress and results go to the
// WmsComparison row, which the page polls.
export function startComparison(
  comparisonId: string,
  provider: WmsProvider,
  credentials: WmsCredentials,
  rows: CatalogRow[],
) {
  const skus = [
    ...new Set(rows.map((r) => r.sku?.trim()).filter((s): s is string => !!s)),
  ];

  active.add(comparisonId);
  void (async () => {
    try {
      let lastWrite = 0;
      const found = await provider.fetchBySku(credentials, skus, async (checked) => {
        if (Date.now() - lastWrite < 2000 && checked < skus.length) return;
        lastWrite = Date.now();
        await prisma.wmsComparison.update({
          where: { id: comparisonId },
          data: { checked },
        });
      });
      const mismatches = compareRows(rows, found, provider.name);
      await prisma.wmsComparison.update({
        where: { id: comparisonId },
        data: {
          status: "done",
          checked: skus.length,
          results: JSON.stringify(mismatches),
          finishedAt: new Date(),
        },
      });
    } catch (error) {
      await prisma.wmsComparison.update({
        where: { id: comparisonId },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      });
    } finally {
      active.delete(comparisonId);
    }
  })();

  return skus.length;
}

// A comparison left "running" by a server restart will never finish.
export async function failStaleComparisons(shop: string) {
  await prisma.wmsComparison.updateMany({
    where: { shop, status: "running", id: { notIn: [...active] } },
    data: { status: "failed", error: "Interrupted by a server restart", finishedAt: new Date() },
  });
}
