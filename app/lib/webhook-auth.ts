// Webhooks that must still run for a store that has removed the app.
//
// authenticate.webhook checks the signature first, then renews the store's
// access token if it has expired. That renewal can't work once the app is
// uninstalled: the library then throws a bare Response(500) with nothing logged,
// and Shopify retries until it gives up. Bad signatures are refused earlier
// with 401 or 400, so a 500 here means the request really came from Shopify.

interface WebhookContext {
  shop: string;
  topic: string;
  session?: unknown;
}

export const webhookAuthWithoutToken =
  <T extends WebhookContext>(authenticate: (request: Request) => Promise<T>) =>
  async (request: Request): Promise<Pick<T, "shop" | "topic" | "session">> => {
    const { headers } = request;
    try {
      return await authenticate(request);
    } catch (err) {
      const shop = headers.get("x-shopify-shop-domain");
      const topic = headers.get("x-shopify-topic");
      if (!(err instanceof Response) || err.status !== 500 || !shop || !topic) throw err;
      console.warn(`[sku-doctor] ${topic} ${shop}: token couldn't be renewed; continuing without it`);
      return { shop, topic: topic.toUpperCase().replace(/\//g, "_"), session: undefined };
    }
  };
