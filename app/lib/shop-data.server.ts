import db from "../db.server";

/**
 * Deletes everything SKU Doctor stores for a shop: sessions, catalog scans,
 * warehouse comparisons, fix history, sync settings and warehouse credentials. Used on uninstall and for
 * Shopify's shop/redact privacy request.
 */
export async function deleteShopData(shop: string) {
  await db.$transaction([
    db.catalogVariant.deleteMany({ where: { shop } }),
    db.catalogScan.deleteMany({ where: { shop } }),
    db.wmsMismatch.deleteMany({ where: { shop } }),
    db.$executeRaw`DELETE FROM "WmsFound" WHERE "comparisonId" IN (SELECT "id" FROM "WmsComparison" WHERE "shop" = ${shop})`,
    db.wmsComparison.deleteMany({ where: { shop } }),
    db.fixItem.deleteMany({ where: { shop } }),
    db.fixBatch.deleteMany({ where: { shop } }),
    db.syncSetting.deleteMany({ where: { shop } }),
    db.syncRun.deleteMany({ where: { shop } }),
    db.wmsConnection.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
