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
    // Shopify's own pages (App Bridge reload, exit iframe) arrive as a 200 HTML body.
    if (error.status === 200 && typeof error.data === "string") {
      return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />;
    }
    return <ProblemPage detail={typeof error.data === "string" ? error.data : null} />;
  }
  console.error(error);
  return <ProblemPage detail={null} />;
}

// Shown instead of a blank error page. Plain HTML: the app frame and Polaris
// aren't loaded when a page fails.
function ProblemPage({ detail }: { detail: string | null }) {
  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", maxWidth: 560, margin: "48px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 20 }}>Something went wrong loading this page</h1>
      <p>
        This is usually temporary. Reload to try again. If it keeps happening, email{" "}
        <a href="mailto:support@thirdaxiscustoms.com">support@thirdaxiscustoms.com</a>
        {detail ? ` and include: “${detail}”` : ""}.
      </p>
      <p style={{ display: "flex", gap: 12 }}>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <a href="/app">Back to SKU Doctor</a>
      </p>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
