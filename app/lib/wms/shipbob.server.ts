import type { WmsCredentials, WmsProduct, WmsProvider } from "./types";
import { TO_LB } from "./units";

// ShipBob's REST API uses dated versions; products list 250 per page.
const API_VERSION = "2026-07";
const PAGE_SIZE = 250;
// Time to leave for one more request before the step's deadline.
const REQUEST_MS = 2500;

const baseUrl = (credentials: WmsCredentials) =>
  /sandbox/i.test(credentials.environment ?? "")
    ? "https://sandbox-api.shipbob.com"
    : "https://api.shipbob.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class OutOfTime extends Error {}

type Json = Record<string, unknown>;

async function get(
  credentials: WmsCredentials,
  url: string,
  deadline: number,
): Promise<{ body: unknown; link: string | null }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${credentials.token}`,
        accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("ShipBob didn't accept the access token. A token stops working when it's revoked or expires, and a sandbox token only works with Environment set to sandbox. Create a new Personal Access Token in ShipBob (Integrations → API Tokens) and enter it again.");
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
      if (Date.now() + wait > deadline) throw new OutOfTime();
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`ShipBob returned ${res.status}`);
    return { body: await res.json(), link: res.headers.get("link") };
  }
  throw new Error("ShipBob kept rate-limiting requests; try again in a minute");
}

// List responses come back as an array or wrapped ({ items | data | products }).
function itemsOf(body: unknown): Json[] {
  if (Array.isArray(body)) return body as Json[];
  const o = (body ?? {}) as Json;
  for (const key of ["items", "data", "products", "results"]) {
    if (Array.isArray(o[key])) return o[key] as Json[];
  }
  return [];
}

// Next page from a `next` URL in the body or an RFC 5988 Link header.
function nextUrlOf(body: unknown, link: string | null, base: string): string | null {
  const o = (Array.isArray(body) ? {} : (body ?? {})) as Json;
  const pagination = (o.pagination ?? {}) as Json;
  const next = (o.next ?? pagination.next) as string | undefined;
  if (typeof next === "string" && next) {
    return next.startsWith("http") ? next : `${base}${next.startsWith("/") ? "" : "/"}${next}`;
  }
  const m = link && /<([^>]+)>;\s*rel="?next"?/i.exec(link);
  return m ? m[1] : null;
}

/** ShipBob weights are ounces as a number, or `{ value|weight, unit }`. */
export function weightLb(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw > 0 ? raw / 16 : null;
  if (typeof raw === "object") {
    const w = raw as Json;
    const value = Number(w.value ?? w.weight ?? w.amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = String(w.unit ?? w.unit_of_measure ?? "oz").toLowerCase();
    return value * (TO_LB[unit] ?? 1 / 16);
  }
  return null;
}

function barcodeOf(v: Json): string | null {
  const list = v.barcodes;
  if (Array.isArray(list) && list.length) {
    const first = list[0] as Json | string;
    const value = typeof first === "string" ? first : (first.value ?? first.barcode);
    if (value) return String(value).trim() || null;
  }
  for (const key of ["barcode", "upc", "gtin"]) {
    const value = v[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Each product's variants (current API), or the product itself (older shape). */
export function variantsOf(product: Json): { sku: string; name: string | null; v: Json }[] {
  const variants = Array.isArray(product.variants) ? (product.variants as Json[]) : [product];
  return variants
    .map((v) => ({
      sku: String(v.sku ?? v.reference_id ?? product.sku ?? product.reference_id ?? "").trim(),
      name: (v.name ?? product.name ?? null) as string | null,
      v,
    }))
    .filter((x) => x.sku);
}

/** Customs value (the usual stand-in for cost), else a plain value or unit price. */
export function costOf(v: Json): number | null {
  const customs = (v.customs ?? {}) as Json;
  for (const raw of [customs.value, v.value, v.unit_price]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function normalize(sku: string, name: string | null, v: Json): WmsProduct {
  return {
    sku,
    name,
    barcode: barcodeOf(v),
    weightLb: weightLb(v.weight ?? (v.dimension as Json | undefined)?.weight),
    // ShipBob keeps no product cost; its customs value is the cost in most setups.
    cost: costOf(v),
    isKit: Boolean(v.is_bundle ?? v.bundle_definition),
  };
}

export const shipbob: WmsProvider = {
  id: "shipbob",
  name: "ShipBob",
  comparesCost: true,
  pagesCatalog: true,
  compareNotes: ["Cost is compared with each product's customs value in ShipBob"],
  setupHelp:
    "Create a Personal Access Token in ShipBob (Integrations → API Tokens). For ShipBob's test environment, type sandbox in Environment.",
  credentialFields: [
    {
      key: "token",
      label: "Personal Access Token",
      secret: true,
      helpText: "Stored encrypted. SKU Doctor only reads products from your warehouse.",
    },
    {
      key: "environment",
      label: "Environment",
      optional: true,
      helpText: "Leave blank for your live ShipBob account, or type sandbox.",
    },
  ],

  async testConnection(credentials) {
    if (!credentials.token) throw new Error("Enter a Personal Access Token");
    const base = baseUrl(credentials);
    try {
      await get(
        credentials,
        `${base}/${API_VERSION}/product?PageSize=1`,
        Date.now() + 6000,
      );
    } catch (error) {
      if (error instanceof OutOfTime) {
        throw new Error("ShipBob is rate-limiting requests; try again in a minute");
      }
      throw error;
    }
  },

  // Pages through the whole ShipBob catalog (fewer requests than one lookup
  // per SKU), keeping the SKUs we're comparing. The cursor is the next page.
  async lookup(credentials, skus, deadline, cursor) {
    const base = baseUrl(credentials);
    const wanted = new Set(skus.map((s) => s.trim().toLowerCase()));
    const found: WmsProduct[] = [];
    let state = cursor
      ? (JSON.parse(cursor) as { url?: string; page?: number })
      : { page: 1 };

    try {
      while (Date.now() + REQUEST_MS < deadline) {
        const url =
          state.url ??
          `${base}/${API_VERSION}/product?PageSize=${PAGE_SIZE}&Page=${state.page ?? 1}`;
        const { body, link } = await get(credentials, url, deadline);
        const items = itemsOf(body);

        for (const product of items) {
          for (const { sku, name, v } of variantsOf(product)) {
            if (wanted.has(sku.toLowerCase())) found.push(normalize(sku, name, v));
          }
        }

        const next = nextUrlOf(body, link, base);
        if (next) state = { url: next };
        else if (items.length >= PAGE_SIZE) state = { page: (state.page ?? 1) + 1 };
        else return { found, processed: skus.length, cursor: null }; // last page
      }
    } catch (error) {
      if (!(error instanceof OutOfTime)) throw error;
    }
    return { found, processed: 0, cursor: JSON.stringify(state) };
  },
};
