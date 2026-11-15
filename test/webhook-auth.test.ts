import { test } from "node:test";
import assert from "node:assert/strict";
import { webhookAuthWithoutToken } from "../app/lib/webhook-auth.ts";

const request = (headers: Record<string, string> = {
  "x-shopify-shop-domain": "a.myshopify.com",
  "x-shopify-topic": "app/uninstalled",
}) => new Request("https://example.com/webhooks/app/uninstalled", { method: "POST", headers });

const failingWith = (err: unknown) => webhookAuthWithoutToken(async () => {
  throw err;
});

test("a normal webhook passes straight through", async () => {
  const context = { shop: "a.myshopify.com", topic: "APP_UNINSTALLED", session: { id: "1" } };
  assert.deepEqual(await webhookAuthWithoutToken(async () => context)(request()), context);
});

test("a token that can't be renewed still gives the shop and topic", async () => {
  assert.deepEqual(await failingWith(new Response(undefined, { status: 500 }))(request()), {
    shop: "a.myshopify.com",
    topic: "APP_UNINSTALLED",
    session: undefined,
  });
});

test("shop/redact topic is normalized", async () => {
  const req = request({ "x-shopify-shop-domain": "a.myshopify.com", "x-shopify-topic": "shop/redact" });
  const { topic } = await failingWith(new Response(undefined, { status: 500 }))(req);
  assert.equal(topic, "SHOP_REDACT");
});

test("a bad signature is still refused", async () => {
  for (const status of [400, 401, 405]) {
    await assert.rejects(failingWith(new Response(undefined, { status }))(request()), (e) => (e as Response).status === status);
  }
});

test("errors that aren't a Response are not hidden", async () => {
  await assert.rejects(failingWith(new Error("Can't reach database server"))(request()), /database/);
});

test("a 500 without both Shopify headers still throws", async () => {
  const err = new Response(undefined, { status: 500 });
  const cases: Record<string, string>[] = [{ "x-shopify-topic": "app/uninstalled" }, { "x-shopify-shop-domain": "a.myshopify.com" }, {}];
  for (const headers of cases) {
    await assert.rejects(failingWith(err)(request(headers)), (e) => e === err);
  }
});
