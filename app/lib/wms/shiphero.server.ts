import { validDims } from "../dimensions";
import { COST_SOURCE_KEY, type WmsCredentials, type WmsProduct, type WmsProvider } from "./types";

const API = "https://public-api.shiphero.com/graphql";
const AUTH = "https://public-api.shiphero.com/auth/refresh";

// SKUs looked up per request, one aliased `products(sku:)` field each. This is
// the same lookup the Make weight/cost syncs use.
const BATCH = 25;

// Requests in flight at once. A request takes a few seconds while ShipHero's
// credits refill quickly, so one at a time left most of the allowance unused.
const PARALLEL = 8;

// Credits one batch can cost (ShipHero measured about 2 per SKU, 3 for kits).
const BATCH_CREDITS = BATCH * 3;

type Dimensions = {
  weight: string | null;
  length?: string | null;
  width?: string | null;
  height?: string | null;
} | null;

// Per-warehouse values, asked for only when a cost warehouse is chosen.
type WarehouseValues = { warehouse_id: string; value: string | null }[] | null;

type Node = {
  sku: string;
  name: string | null;
  barcode: string | null;
  value: string | null;
  dimensions: Dimensions;
  warehouse_products?: WarehouseValues;
  kit_components:
    | {
        quantity: number | null;
        product: {
          value: string | null;
          dimensions: Dimensions;
          warehouse_products?: WarehouseValues;
        } | null;
      }[]
    | null;
};

type GqlError = { message?: string; code?: number; time_remaining?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Thrown when waiting for ShipHero (credits, retries) would run past the
// step's deadline; the lookup stops and the next step continues.
class OutOfTime extends Error {}

async function waitOrStop(ms: number, deadline: number) {
  if (Date.now() + ms > deadline) throw new OutOfTime();
  await sleep(ms);
}

// Longest a connection test may wait on ShipHero.
const STEP_TEST_MS = 6000;

// Time to leave for one more request before the deadline.
const REQUEST_MS = 2500;

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
      `ShipHero didn't accept the refresh token (${res.status}${json.error ? `: ${json.error}` : ""}). A refresh token stops working when it's revoked or replaced. Create a new one in ShipHero and enter it again.`,
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

let requestCount = 0;

// The credit balance ShipHero last reported for each refresh token, used to
// send only as many requests at once as the balance covers.
type Quota = { remaining: number; rate: number; at: number };
const quotas = new Map<string, Quota>();

function recordQuota(refreshToken: string, extensions: unknown) {
  const q = (extensions as { throttling?: { user_quota?: { credits_remaining?: number; increment_rate?: number } } })
    ?.throttling?.user_quota;
  if (typeof q?.credits_remaining === "number" && typeof q.increment_rate === "number") {
    quotas.set(refreshToken, { remaining: q.credits_remaining, rate: q.increment_rate, at: Date.now() });
  }
}

/** How many batches to send now, and how long to wait first if none fit. */
export function nextWave(quota: Quota | undefined, now = Date.now()) {
  if (!quota) return { size: 1, waitMs: 0 }; // learn the balance first
  const credits = quota.remaining + (quota.rate * (now - quota.at)) / 1000;
  const size = Math.min(PARALLEL, Math.floor(credits / BATCH_CREDITS));
  if (size >= 1) return { size, waitMs: 0 };
  const waitMs = Math.ceil(((BATCH_CREDITS - credits) / Math.max(quota.rate, 1)) * 1000);
  return { size: 1, waitMs };
}

async function query<T>(
  credentials: WmsCredentials,
  body: string,
  deadline = Infinity,
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
      await waitOrStop(2000 * (attempt + 1), deadline);
      continue;
    }
    const json = (await res.json()) as { data?: T; errors?: GqlError[]; extensions?: unknown };
    recordQuota(credentials.refreshToken, json.extensions);
    // Every 50th response, log ShipHero's reported cost so batching can be tuned.
    if (++requestCount % 50 === 1 && json.extensions) {
      console.log(`[shiphero] cost sample: ${JSON.stringify(json.extensions).slice(0, 300)}`);
    }
    if (json.errors?.length) {
      const wait = creditWaitMs(json.errors);
      if (wait !== null) {
        // ShipHero's numbers (cost, credits left) say how to batch requests better.
        console.warn(`[shiphero] credits: waiting ${wait} ms: ${JSON.stringify(json.errors[0]).slice(0, 300)}`);
        await waitOrStop(wait, deadline);
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

// ShipHero returns lengths as text such as "11.5 in" or "29 cm".
export function parseLengthIn(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*([\d.]+)\s*([a-z]*)/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2].toLowerCase()) {
    case "cm":
      return n / 2.54;
    case "mm":
      return n / 25.4;
    case "m":
      return n * 39.3700787;
    case "ft":
      return n * 12;
    default:
      return n; // in or no unit
  }
}

const dimsOf = (d: Dimensions) =>
  validDims({
    length: parseLengthIn(d?.length) ?? undefined,
    width: parseLengthIn(d?.width) ?? undefined,
    height: parseLengthIn(d?.height) ?? undefined,
  });

const num = (raw: string | null | undefined) => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// Kits often carry no weight or cost of their own; fall back to the sum of
// their components, matching the Make syncs.
// With a cost warehouse chosen, cost is that warehouse's value; a SKU it
// doesn't stock has no cost to compare.
const costOf = (
  item: { value: string | null; warehouse_products?: WarehouseValues },
  warehouse?: string,
) =>
  warehouse
    ? num(item.warehouse_products?.find((w) => w.warehouse_id === warehouse)?.value)
    : num(item.value);

export function normalize(node: Node, costWarehouse?: string): WmsProduct {
  const components = node.kit_components ?? [];
  const ownWeight = parseWeightLb(node.dimensions?.weight);
  const ownCost = costOf(node, costWarehouse);

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
        : (sum((c) => (c.product ? costOf(c.product, costWarehouse) : null)) ?? ownCost),
    // A kit without a size of its own ships as its only component, as in the Make sync.
    dims:
      dimsOf(node.dimensions) ??
      (components.length === 1 ? dimsOf(components[0].product?.dimensions ?? null) : null),
    isKit: components.length > 0,
  };
}

const escapeSku = (sku: string) => sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function lookupQuery(skus: string[], customerAccountId?: string, perWarehouse = false) {
  const account = customerAccountId
    ? `, customer_account_id: "${escapeSku(customerAccountId)}"`
    : "";
  const values = perWarehouse ? " warehouse_products { warehouse_id value }" : "";
  const fields = skus
    .map(
      (sku, i) =>
        `s${i}: products(sku: "${escapeSku(sku)}"${account}) { data(first: 1) { edges { node { sku name barcode value dimensions { weight length width height }${values} kit_components { quantity product { value dimensions { weight length width height }${values} } } } } } }`,
    )
    .join("\n");
  return `query {\n${fields}\n}`;
}

type LookupResult = Record<string, { data: { edges: { node: Node }[] } } | null>;

export const shiphero: WmsProvider = {
  id: "shiphero",
  name: "ShipHero",
  comparesCost: true,
  pagesCatalog: false,
  hasDimensions: true,
  compareNotes: [
    "Kits with no weight or cost of their own use the sum of their components",
  ],
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
    try {
      await query(
        credentials,
        lookupQuery(["__sku_doctor_connection_test__"], credentials.customerAccountId),
        Date.now() + STEP_TEST_MS,
      );
    } catch (error) {
      if (error instanceof OutOfTime) {
        throw new Error("ShipHero is rate-limiting requests; try again in a minute");
      }
      throw error;
    }
  },

  async costSources(credentials) {
    const data = await query<{
      account: { data: { warehouses: { id: string; identifier: string | null }[] | null } | null };
    }>(credentials, "query { account { data { warehouses { id identifier } } } }");
    return (data.account.data?.warehouses ?? []).map((w) => ({
      id: w.id,
      name: w.identifier || w.id,
    }));
  },

  async lookup(credentials, skus, deadline) {
    const found: WmsProduct[] = [];
    let processed = 0;
    const costWarehouse = credentials[COST_SOURCE_KEY] || undefined;

    const lookupBatch = async (batch: string[]) => {
      const data = await query<LookupResult>(
        credentials,
        lookupQuery(batch, credentials.customerAccountId, !!costWarehouse),
        deadline,
      );
      const hits: WmsProduct[] = [];
      batch.forEach((sku, j) => {
        const node = data[`s${j}`]?.data?.edges?.[0]?.node;
        // products(sku:) can match loosely; only accept the exact SKU.
        if (node && node.sku?.trim().toLowerCase() === sku.trim().toLowerCase()) {
          hits.push(normalize(node, costWarehouse));
        }
      });
      return hits;
    };

    try {
      while (processed < skus.length && Date.now() + REQUEST_MS < deadline) {
        const wave = nextWave(quotas.get(credentials.refreshToken));
        if (wave.waitMs) await waitOrStop(wave.waitMs, deadline);
        const batches: string[][] = [];
        for (let i = 0; i < wave.size && processed + i * BATCH < skus.length; i++) {
          const start = processed + i * BATCH;
          batches.push(skus.slice(start, start + BATCH));
        }
        const results = await Promise.allSettled(batches.map(lookupBatch));
        // Only SKUs from the front of the list count as done, so stop at the
        // first batch that didn't finish; the next step retries from there.
        for (const [i, result] of results.entries()) {
          if (result.status === "rejected") throw result.reason;
          found.push(...result.value);
          processed += batches[i].length;
        }
      }
    } catch (error) {
      if (!(error instanceof OutOfTime)) throw error;
    }
    return { found, processed };
  },
};
