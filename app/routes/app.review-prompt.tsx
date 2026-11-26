import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordReviewPrompt, reviewPromptDue } from "../lib/review-prompt.server";

// Used by app/lib/review-prompt.ts: whether to ask for a review now, and
// recording that it asked.
// Shopify skips its review limits on development stores; so does the 60-day
// wait here, so the prompt can be tested there more than once.
const DEV_STORE = `#graphql
  query ReviewPromptShopPlan {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }
`;

async function isDevelopmentStore(admin: { graphql: (q: string) => Promise<Response> }) {
  try {
    const json = (await (await admin.graphql(DEV_STORE)).json()) as {
      data?: { shop: { plan: { partnerDevelopment: boolean } } };
    };
    return json.data?.shop.plan.partnerDevelopment === true;
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const due = (await reviewPromptDue(session.shop)) || (await isDevelopmentStore(admin));
  return Response.json({ due });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await recordReviewPrompt(session.shop);
  return Response.json({ ok: true });
};
