import type { WmsCredentials, WmsProduct, WmsProvider } from "./types";
import { TO_LB } from "./units";

const BASE_URL = "https://api.veeqo.com";
// Veeqo returns at most 100 products per page.
const PAGE_SIZE = 100;
// Time to leave for one more request before the step's deadline.
const REQUEST_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class OutOfTime extends Error {}

type Json = Record<string, unknown>;

async function get(
  credentials: WmsCredentials,
  path: string,
  deadline: number,
): Promise<{ body: unknown; total: number | null }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE_URL}/${path}`, {
      headers: { "x-api-key": credentials.apiKey ?? "", accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Veeqo rejected the API key. Check it and try again.");
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
      if (Date.now() + wait > deadline) throw new OutOfTime();
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Veeqo returned ${res.status}`);
    const total = Number(res.headers.get("x-total-count"));
    return { body: await res.json(), total: Number.isFinite(total) && total > 0 ? total : null };
  }
  throw new Error("Veeqo kept rate-limiting requests; try again in a minute");
}

const positive = (raw: unknown) => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Veeqo weights are grams (weight_grams), or a weight with its own unit. */
export function weightLb(s: Json): number | null {
  const grams = positive(s.weight_grams);
  if (grams !== null) return grams * TO_LB.g;
  const value = positive(s.weight);
  if (value === null) return null;
  const unit = String(s.weight_unit ?? "g").trim().toLowerCase();
  return value * (TO_LB[unit] ?? TO_LB.g);
}

export function normalize(product: Json, s: Json): WmsProduct {
  const barcode = String(s.upc_code ?? s.barcode ?? "").trim();
  const title = (s.full_title ?? s.title ?? product.title ?? null) as string | null;
  return {
    sku: String(s.sku_code ?? "").trim(),
    name: title,
    barcode: barcode || null,
    weightLb: weightLb(s),
    cost: positive(s.cost_price),
    isKit: /kit|bundle/i.test(String(s.type ?? s.sellable_type ?? "")),
  };
}

export const veeqo: WmsProvider = {
  id: "veeqo",
  name: "Veeqo",
  comparesCost: true,
  pagesCatalog: true,
  compareNotes: ["Cost is each product's cost price in Veeqo"],
  setupHelp:
    "In Veeqo, go to Settings → Users, click the pencil next to your user, and choose Refresh API Key in the API Key section. The key is shown only once. No API Key section? Ask Veeqo support to enable API access for your account.",
  credentialFields: [
    {
      key: "apiKey",
      label: "API key",
      secret: true,
      helpText: "Stored encrypted. SKU Doctor only reads products from your warehouse.",
    },
  ],

  async testConnection(credentials) {
    if (!credentials.apiKey) throw new Error("Enter a Veeqo API key");
    try {
      await get(credentials, "products?page_size=1&page=1", Date.now() + 6000);
    } catch (error) {
      if (error instanceof OutOfTime) {
        throw new Error("Veeqo is rate-limiting requests; try again in a minute");
      }
      throw error;
    }
  },

  // Pages through the whole Veeqo catalog, keeping the SKUs we're comparing.
  // Each product's variants and kits are its "sellables".
  async lookup(credentials, skus, deadline, cursor) {
    const wanted = new Set(skus.map((s) => s.trim().toLowerCase()));
    const found: WmsProduct[] = [];
    let state = cursor
      ? (JSON.parse(cursor) as { page: number; read: number })
      : { page: 1, read: 0 };

    try {
      while (Date.now() + REQUEST_MS < deadline) {
        const { body, total } = await get(
          credentials,
          `products?page_size=${PAGE_SIZE}&page=${state.page}`,
          deadline,
        );
        const products = Array.isArray(body) ? (body as Json[]) : [];
        for (const product of products) {
          const sellables = Array.isArray(product.sellables) ? (product.sellables as Json[]) : [];
          for (const s of sellables) {
            const item = normalize(product, s);
            if (item.sku && wanted.has(item.sku.toLowerCase())) found.push(item);
          }
        }
        state = { page: state.page + 1, read: state.read + products.length };

        const done =
          products.length < PAGE_SIZE || (total !== null && state.read >= total);
        if (done) return { found, processed: skus.length, cursor: null };
      }
    } catch (error) {
      if (!(error instanceof OutOfTime)) throw error;
    }
    return { found, processed: 0, cursor: JSON.stringify(state) };
  },
};
