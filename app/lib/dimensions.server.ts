import type { ApiVersion } from "@shopify/shopify-api";

// Shopify's API has packed product size from version 2027-01, a release
// candidate until it becomes stable on 1 January 2027. Until then it's off
// unless the site sets PACKED_DIMENSIONS=on; only the requests that read or
// write dimensions use that version.
export const DIMENSIONS_API_VERSION = "2027-01" as ApiVersion;
const STABLE_FROM = Date.UTC(2027, 0, 1, 17);

export function dimensionsEnabled() {
  const flag = process.env.PACKED_DIMENSIONS?.trim().toLowerCase();
  if (flag === "off") return false;
  return flag === "on" || Date.now() >= STABLE_FROM;
}
