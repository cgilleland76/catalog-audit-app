import db from "../db.server";

/**
 * Deletes everything SKU Doctor stores for a shop: sessions, catalog scans,
 * warehouse comparisons and warehouse credentials. Used on uninstall and for
 * Shopify's shop/redact privacy request.
 */
export async function deleteShopData(shop: string) {
  await db.$transaction([
    db.catalogScan.deleteMany({ where: { shop } }),
    db.wmsComparison.deleteMany({ where: { shop } }),
    db.wmsConnection.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
