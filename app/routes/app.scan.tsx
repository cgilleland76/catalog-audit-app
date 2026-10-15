import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getScanState, startScan } from "../lib/catalog.server";

// Status of the catalog scan, polled by the pages while a scan runs.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return { scan: await getScanState(session.shop, admin) };
};

// Starts a new scan.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return { scan: await startScan(session.shop, admin) };
};
