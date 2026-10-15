import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { CatalogRow } from "./catalog";

// One page of variants with the product fields both features need.
// Kept at 100 per page so the query stays well under the 1000-point cost limit.
const VARIANTS_QUERY = `#graphql
  query CatalogVariants($after: String) {
    productVariants(first: 100, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
        inventoryItem {
          requiresShipping
          unitCost {
            amount
          }
          measurement {
            weight {
              value
              unit
            }
          }
        }
        product {
          id
          title
          handle
          status
          vendor
          productType
          tags
          featuredMedia {
            preview {
              image {
                url(transform: { maxWidth: 400, maxHeight: 400 })
              }
            }
          }
        }
      }
    }
  }
`;

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    requiresShipping: boolean;
    unitCost: { amount: string } | null;
    measurement: { weight: { value: number; unit: string } | null } | null;
  } | null;
  product: {
    id: string;
    title: string;
    handle: string;
    status: string;
    vendor: string;
    productType: string;
    tags: string[];
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  };
};

type VariantsResponse = {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: VariantNode[];
    };
  };
  errors?: unknown;
};

const MAX_PAGES = 200; // 20,000 variants

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isThrottled = (value: unknown) =>
  JSON.stringify(value ?? "").includes("THROTTLED");

async function fetchPage(
  admin: AdminApiContext,
  after: string | null,
): Promise<VariantsResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await admin.graphql(VARIANTS_QUERY, {
        variables: { after },
        tries: 3,
      });
      const json = (await response.json()) as VariantsResponse;
      if (json.errors && isThrottled(json.errors) && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return json;
    } catch (error) {
      const body = (error as { body?: unknown }).body;
      if ((isThrottled(body) || isThrottled(String(error))) && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

const toNumber = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? null : Number(value);

export async function fetchCatalog(admin: AdminApiContext): Promise<{
  rows: CatalogRow[];
  truncated: boolean;
}> {
  const rows: CatalogRow[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchPage(admin, after);
    if (!json.data) {
      throw new Error(`Catalog query failed: ${JSON.stringify(json.errors)}`);
    }
    const { nodes, pageInfo } = json.data.productVariants;

    for (const v of nodes) {
      const weight = v.inventoryItem?.measurement?.weight ?? null;
      rows.push({
        variantId: v.id,
        variantTitle: v.title,
        productId: v.product.id,
        productTitle: v.product.title,
        handle: v.product.handle,
        status: v.product.status,
        vendor: v.product.vendor,
        productType: v.product.productType,
        tags: v.product.tags,
        imageUrl: v.product.featuredMedia?.preview?.image?.url ?? null,
        sku: v.sku?.trim() || null,
        barcode: v.barcode?.trim() || null,
        price: toNumber(v.price) ?? 0,
        compareAtPrice: toNumber(v.compareAtPrice),
        cost: toNumber(v.inventoryItem?.unitCost?.amount),
        weight: weight ? weight.value : null,
        weightUnit: weight ? weight.unit : null,
        requiresShipping: v.inventoryItem?.requiresShipping ?? true,
        inventoryQuantity: v.inventoryQuantity,
      });
    }

    if (!pageInfo.hasNextPage) return { rows, truncated: false };
    after = pageInfo.endCursor;
  }

  return { rows, truncated: true };
}
