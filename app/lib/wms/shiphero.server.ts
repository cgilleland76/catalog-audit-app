import type { WmsCredentials, WmsProduct, WmsProvider } from "./types";

const API = "https://public-api.shiphero.com/graphql";
const AUTH = "https://public-api.shiphero.com/auth/refresh";

// SKUs looked up per request, one aliased `products(sku:)` field each. This is
// the same lookup the Make weight/cost syncs use.
const BATCH = 25;

type Node = {
  sku: string;
  name: string | null;
  barcode: string | null;
  value: string | null;
  dimensions: { weight: string | null } | null;
  kit_components:
    | {
        quantity: number | null;
        product: {
          value: string | null;
          dimensions: { weight: string | null } | null;
        } | null;
      }[]
    | null;
};

type GqlError = { message?: string; code?: number; time_remaining?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(refreshToken: string): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(AUTH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(
      `ShipHero rejected the refresh token (${res.status}${json.error ? `: ${json.error}` : ""})`,
    );
  }
  tokenCache.set(refreshToken, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

// ShipHero meters requests in credits and answers "not enough credits ... In N
// seconds" when we go too fast; wait that long and retry.
function creditWaitMs(errors: GqlError[]): number | null {
  for (const e of errors) {
    const text = `${e.message ?? ""} ${e.time_remaining ?? ""}`;
    if (e.code === 30 || /credits/i.test(text)) {
      const secs = Number(/(\d+)\s*second/i.exec(text)?.[1] ?? 5);
      return (secs + 1) * 1000;
    }
  }
  return null;
}

async function query<T>(
  credentials: WmsCredentials,
  body: string,
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const token = await accessToken(credentials.refreshToken);
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: body }),
    });
    if (res.status === 401) {
      tokenCache.delete(credentials.refreshToken);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const json = (await res.json()) as { data?: T; errors?: GqlError[] };
    if (json.errors?.length) {
      const wait = creditWaitMs(json.errors);
      if (wait !== null) {
        await sleep(wait);
        continue;
      }
      throw new Error(
        `ShipHero: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) throw new Error(`ShipHero returned no data (${res.status})`);
    return json.data;
  }
  throw new Error("ShipHero kept throttling requests; try again in a minute");
}

// ShipHero returns measurements as text such as "1.25 lb" or "12 oz".
export function parseWeightLb(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*([\d.]+)\s*([a-z]*)/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2].toLowerCase()) {
    case "oz":
      return n / 16;
    case "g":
      return n / 453.59237;
    case "kg":
      return n * 2.20462262;
    default:
      return n; // lb, lbs or no unit
  }
}

const num = (raw: string | null | undefined) => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// Kits often carry no weight or cost of their own; fall back to the sum of
// their components, matching the Make syncs.
export function normalize(node: Node): WmsProduct {
  const components = node.kit_components ?? [];
  const ownWeight = parseWeightLb(node.dimensions?.weight);
  const ownCost = num(node.value);

  const sum = (pick: (c: (typeof components)[number]) => number | null) => {
    if (components.length === 0) return null;
    let total = 0;
    for (const c of components) total += (pick(c) ?? 0) * (c.quantity ?? 1);
    return total > 0 ? total : null;
  };

  return {
    sku: node.sku,
    name: node.name,
    barcode: node.barcode?.trim() || null,
    weightLb:
      ownWeight && ownWeight > 0
        ? ownWeight
        : (sum((c) => parseWeightLb(c.product?.dimensions?.weight)) ?? ownWeight),
    cost:
      ownCost && ownCost > 0
        ? ownCost
        : (sum((c) => num(c.product?.value)) ?? ownCost),
    isKit: components.length > 0,
  };
}

const escapeSku = (sku: string) => sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function lookupQuery(skus: string[], customerAccountId?: string) {
  const account = customerAccountId
    ? `, customer_account_id: "${escapeSku(customerAccountId)}"`
    : "";
  const fields = skus
    .map(
      (sku, i) =>
        `s${i}: products(sku: "${escapeSku(sku)}"${account}) { data(first: 1) { edges { node { sku name barcode value dimensions { weight } kit_components { quantity product { value dimensions { weight } } } } } } }`,
    )
    .join("\n");
  return `query {\n${fields}\n}`;
}

type LookupResult = Record<string, { data: { edges: { node: Node }[] } } | null>;

export const shiphero: WmsProvider = {
  id: "shiphero",
  name: "ShipHero",
  setupHelp:
    "Create an API refresh token in ShipHero (a third-party developer user's token works). Brands on a 3PL's ShipHero account also need their customer account ID.",
  credentialFields: [
    {
      key: "refreshToken",
      label: "Refresh token",
      secret: true,
      helpText: "Used to get short-lived access tokens. Stored encrypted.",
    },
    {
      key: "customerAccountId",
      label: "Customer account ID (3PL only)",
      optional: true,
    },
  ],

  async testConnection(credentials) {
    if (!credentials.refreshToken) throw new Error("Enter a refresh token");
    await query(credentials, lookupQuery(["__sku_doctor_connection_test__"], credentials.customerAccountId));
  },

  async fetchBySku(credentials, skus, onProgress) {
    const found = new Map<string, WmsProduct>();
    for (let i = 0; i < skus.length; i += BATCH) {
      const batch = skus.slice(i, i + BATCH);
      const data = await query<LookupResult>(
        credentials,
        lookupQuery(batch, credentials.customerAccountId),
      );
      batch.forEach((sku, j) => {
        const node = data[`s${j}`]?.data?.edges?.[0]?.node;
        // products(sku:) can match loosely; only accept the exact SKU.
        if (node && node.sku?.trim().toLowerCase() === sku.trim().toLowerCase()) {
          found.set(sku.trim().toLowerCase(), normalize(node));
        }
      });
      await onProgress(Math.min(i + BATCH, skus.length));
    }
    return found;
  },
};
