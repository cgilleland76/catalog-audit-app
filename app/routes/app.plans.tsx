import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { billingEnabled, getPlan, planOverride, planSelectionUrl } from "../lib/plans.server";
import { PLANS, type PlanId } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Shopify sends the merchant back with ?plan_handle= after they choose a plan.
  const fresh = new URL(request.url).searchParams.has("plan_handle");
  return {
    plan: await getPlan(session.shop, admin, { fresh }),
    upgradeUrl: planSelectionUrl(session.shop),
    // The dev site has no Shopify plan picker to link to.
    overridden: planOverride() !== null || !billingEnabled(),
  };
};

const ORDER: PlanId[] = ["free", "pro", "warehouse"];

export default function PlansPage() {
  const { plan, upgradeUrl, overridden } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plans">
      {!overridden && (
        <s-button slot="primary-action" variant="primary" href={upgradeUrl} target="_top">
          {plan === "free" ? "Choose a plan" : "Change plan"}
        </s-button>
      )}

      {overridden && (
        <s-banner tone="info" heading="Test app: billing is off">
          This copy of SKU Doctor has the {PLANS[plan].name} plan unlocked for
          testing, so there&apos;s no plan to choose or pay for here.
        </s-banner>
      )}

      <s-section>
        <s-paragraph>
          You&apos;re on the <s-text type="strong">{PLANS[plan].name}</s-text> plan.
          Paid plans start with a 14-day free trial and are billed monthly
          through your Shopify invoice. You can change or cancel anytime.
        </s-paragraph>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
        {ORDER.map((id) => {
          const p = PLANS[id];
          const current = id === plan;
          return (
            <s-section key={id} heading={p.name}>
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-heading>{p.price}</s-heading>
                  {current && <s-badge tone="success">Current plan</s-badge>}
                </s-stack>
                <s-unordered-list>
                  {p.features.map((f) => (
                    <s-list-item key={f}>{f}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            </s-section>
          );
        })}
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
