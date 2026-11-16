import { test } from "node:test";
import assert from "node:assert/strict";
import { shipbob } from "../app/lib/wms/shipbob.server.ts";
import { cin7 } from "../app/lib/wms/cin7.server.ts";

// Paging through a warehouse catalog must read every product however the API
// pages (next links or page numbers, any page size) and never loop forever.

type Lookup = typeof shipbob.lookup;

async function readAll(lookup: Lookup, credentials: Record<string, string>, skus: string[]) {
  const found = new Set<string>();
  let cursor: string | null = null;
  let steps = 0;
  do {
    const r = await lookup(credentials, skus, Date.now() + 10_000, cursor);
    r.found.forEach((p) => found.add(p.sku));
    cursor = r.cursor ?? null;
  } while (cursor && ++steps < 20);
  return found;
}

function mockFetch(respond: (url: URL) => unknown) {
  let calls = 0;
  globalThis.fetch = (async (input: string) => {
    calls++;
    return new Response(JSON.stringify(respond(new URL(input))));
  }) as typeof fetch;
  return () => calls;
}

const sbProducts = Array.from({ length: 130 }, (_, i) => ({
  id: i,
  variants: [{ sku: `SB-${i}`, customs: { value: 10 } }],
}));
const sbSkus = sbProducts.map((p) => p.variants[0].sku);
const sbPage = (page: number) => sbProducts.slice((page - 1) * 50, page * 50);

test("ShipBob: follows next links to the end", async () => {
  const calls = mockFetch((u) => {
    const page = Number(u.searchParams.get("p") ?? 1);
    return { items: sbPage(page), ...(page * 50 < 130 ? { next: `/2026-07/product?p=${page + 1}` } : {}) };
  });
  assert.equal((await readAll(shipbob.lookup, { token: "t" }, sbSkus)).size, 130);
  assert.ok(calls() <= 3);
});

test("ShipBob: pages by number when pages are smaller than asked and have no links", async () => {
  const calls = mockFetch((u) => ({ items: sbPage(Number(u.searchParams.get("Page"))) }));
  assert.equal((await readAll(shipbob.lookup, { token: "t" }, sbSkus)).size, 130);
  assert.ok(calls() <= 4);
});

test("ShipBob: stops when the API ignores the page number", async () => {
  const calls = mockFetch(() => ({ items: sbPage(1) }));
  assert.equal((await readAll(shipbob.lookup, { token: "t" }, sbSkus)).size, 50);
  assert.ok(calls() <= 2);
});

test("ShipBob: stops when the API repeats its last page", async () => {
  const calls = mockFetch((u) => ({ items: sbPage(Math.min(Number(u.searchParams.get("Page")), 3)) }));
  assert.equal((await readAll(shipbob.lookup, { token: "t" }, sbSkus)).size, 130);
  assert.ok(calls() <= 4);
});

const c7Products = Array.from({ length: 2300 }, (_, i) => ({ SKU: `C-${i}`, Weight: 1, WeightUnits: "lb" }));
const c7Skus = c7Products.map((p) => p.SKU);
const c7Page = (page: number) => c7Products.slice((page - 1) * 1000, page * 1000);
const c7Credentials = { accountId: "a", applicationKey: "k" };

test("Cin7 Core: reads every page, with or without Total", async () => {
  mockFetch((u) => ({ Products: c7Page(Number(u.searchParams.get("Page"))), Total: 2300 }));
  assert.equal((await readAll(cin7.lookup, c7Credentials, c7Skus)).size, 2300);
  mockFetch((u) => ({ Products: c7Page(Number(u.searchParams.get("Page"))) }));
  assert.equal((await readAll(cin7.lookup, c7Credentials, c7Skus)).size, 2300);
});

test("Cin7 Core: stops when the API ignores the page number", async () => {
  const calls = mockFetch(() => ({ Products: c7Page(1) }));
  assert.equal((await readAll(cin7.lookup, c7Credentials, c7Skus)).size, 1000);
  assert.ok(calls() <= 2);
});
