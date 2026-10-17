import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { UPCOMING, UPDATES } from "../lib/site-content";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

export default function UpdatesPage() {
  return (
    <s-page heading="Updates">
      {UPCOMING.length > 0 && (
        <s-section heading="Coming soon">
          <s-stack direction="block" gap="small">
            {UPCOMING.map((u) => (
              <s-stack key={u.title} direction="block" gap="small-200">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">{u.title}</s-text>
                  <s-badge tone="info">Upcoming</s-badge>
                </s-stack>
                <s-text>{u.description}</s-text>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}
      {UPDATES.map((u) => (
        <s-section key={u.date + u.title} heading={u.title}>
          <s-stack direction="block" gap="small">
            <s-text color="subdued">{formatDate(u.date)}</s-text>
            <s-unordered-list>
              {u.items.map((item) => (
                <s-list-item key={item}>{item}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
