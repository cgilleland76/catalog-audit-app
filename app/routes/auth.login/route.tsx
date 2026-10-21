import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { errors } = actionData || loaderData;

  // Merchants open SKU Doctor from Shopify; it never asks for a store address
  // (App Store requirement 2.3.1). Shopify's own ?shop= links still work above.
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", maxWidth: 560, margin: "48px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 20 }}>Open SKU Doctor from Shopify</h1>
      <p>
        Install SKU Doctor from the Shopify App Store, then open it from <strong>Apps</strong> in
        your Shopify admin.
      </p>
      {errors.shop && <p role="alert">{errors.shop}</p>}
    </main>
  );
}
