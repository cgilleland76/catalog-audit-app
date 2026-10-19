import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Catalog audit</s-link>
        <s-link href="/app/linesheet">Line sheet</s-link>
        <s-link href="/app/warehouse">Warehouse</s-link>
        <s-link href="/app/history">History</s-link>
        <s-link href="/app/plans">Plans</s-link>
        <s-link href="/app/updates">Updates</s-link>
        <s-link href="/app/support">Support</s-link>
      </s-app-nav>
      <NavigationLoading />
      <Outlet />
    </AppProvider>
  );
}

// Shows the admin's loading bar while moving between pages.
function NavigationLoading() {
  const shopify = useAppBridge();
  const { state } = useNavigation();
  useEffect(() => {
    shopify.loading(state !== "idle");
  }, [shopify, state]);
  return null;
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// boundary.error recognises those responses by class name, which the production
// browser build shortens, so the page showed a bare "200" (e.g. App Bridge's
// reload page after a deploy). Check the type instead.
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />;
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
