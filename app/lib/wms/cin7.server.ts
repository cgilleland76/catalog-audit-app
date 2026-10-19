import type { WmsCredentials, WmsProduct, WmsProvider } from "./types";
import { TO_LB } from "./units";

// Cin7 Core (formerly DEAR Inventory) API v2.
const BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2";
const PAGE_SIZE = 1000;
// Time to leave for one more request before the step's deadline.
const REQUEST_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class OutOfTime extends Error {}

type Json = Record<string, unknown>;

async function get(credentials: WmsCredentials, path: string, deadline: number): Promise<Json> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE_URL}/${path}`, {
      headers: {
        "api-auth-accountid": credentials.accountId ?? "",
        "api-auth-applicationkey": credentials.applicationKey ?? "",
        accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Cin7 Core rejected the Account ID or Application Key. Check both.");
    }
    // Cin7 Core allows about 60 calls a minute and answers 429 or 503 past that.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
      if (Date.now() + wait > deadline) throw new OutOfTime();
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Cin7 Core returned ${res.status}`);
    return (await res.json()) as Json;
  }
  throw new Error("Cin7 Core kept rate-limiting requests; try again in a minute");
}

const positive = (raw: unknown) => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Cin7 Core weights carry their own unit (WeightUnits); kilograms otherwise. */
export function weightLb(p: Json): number | null {
  const value = positive(p.Weight);
  if (value === null) return null;
  const unit = String(p.WeightUnits ?? "kg").trim().toLowerCase();
  return value * (TO_LB[unit] ?? TO_LB.kg);
}

/** Average cost, else the first supplier's price. */
export function costOf(p: Json): number | null {
  const average = positive(p.AverageCost);
  if (average !== null) return average;
  const suppliers = Array.isArray(p.Suppliers) ? (p.Suppliers as Json[]) : [];
  for (const s of suppliers) {
    const cost = positive(s.Cost ?? s.Price);
    if (cost !== null) return cost;
  }
  return null;
}

export function normalize(p: Json): WmsProduct {
  const barcode = typeof p.Barcode === "string" ? p.Barcode.trim() : "";
  return {
    sku: String(p.SKU ?? "").trim(),
    name: (p.Name as string | undefined) ?? null,
    barcode: barcode || null,
    weightLb: weightLb(p),
    cost: costOf(p),
    isKit: p.BillOfMaterial === true || /kit|bundle/i.test(String(p.Type ?? "")),
  };
}

export const cin7: WmsProvider = {
  id: "cin7",
  name: "Cin7 Core",
  comparesCost: true,
  pagesCatalog: true,
  compareNotes: ["Cost is the product's average cost in Cin7 Core (or its supplier price)"],
  setupHelp:
    "In Cin7 Core, go to Integrations → API and choose + to create an API application. Copy its Account ID and Application Key.",
  credentialFields: [
    { key: "accountId", label: "Account ID" },
    {
      key: "applicationKey",
      label: "Application Key",
      secret: true,
      helpText: "Stored encrypted. SKU Doctor only reads products from your warehouse.",
    },
  ],

  async testConnection(credentials) {
    if (!credentials.accountId || !credentials.applicationKey) {
      throw new Error("Enter the Account ID and Application Key");
    }
    try {
      await get(credentials, "product?Page=1&Limit=1", Date.now() + 6000);
    } catch (error) {
      if (error instanceof OutOfTime) {
        throw new Error("Cin7 Core is rate-limiting requests; try again in a minute");
      }
      throw error;
    }
  },

  // Pages through the whole Cin7 Core catalog, keeping the SKUs we're
  // comparing. The cursor is the next page and how many products were read.
  async lookup(credentials, skus, deadline, cursor) {
    const wanted = new Set(skus.map((s) => s.trim().toLowerCase()));
    const found: WmsProduct[] = [];
    let state = cursor
      ? (JSON.parse(cursor) as { page: number; read: number })
      : { page: 1, read: 0 };

    try {
      while (Date.now() + REQUEST_MS < deadline) {
        const body = await get(
          credentials,
          `product?Page=${state.page}&Limit=${PAGE_SIZE}`,
          deadline,
        );
        const products = Array.isArray(body.Products) ? (body.Products as Json[]) : [];
        for (const p of products) {
          const product = normalize(p);
          if (product.sku && wanted.has(product.sku.toLowerCase())) found.push(product);
        }
        state = { page: state.page + 1, read: state.read + products.length };

        // Stop on an empty page or once Total products are read (the page
        // size Cin7 Core uses may be smaller than the one asked for).
        const total = Number(body.Total);
        if (products.length === 0 || (Number.isFinite(total) && state.read >= total)) {
          return { found, processed: skus.length, cursor: null };
        }
      }
    } catch (error) {
      if (!(error instanceof OutOfTime)) throw error;
    }
    return { found, processed: 0, cursor: JSON.stringify(state) };
  },
};
