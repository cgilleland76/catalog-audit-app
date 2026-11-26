import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordReviewPrompt, reviewPromptDue } from "../lib/review-prompt.server";

// Used by app/lib/review-prompt.ts: whether to ask for a review now, and
// recording that it asked.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return Response.json({ due: await reviewPromptDue(session.shop) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await recordReviewPrompt(session.shop);
  return Response.json({ ok: true });
};
