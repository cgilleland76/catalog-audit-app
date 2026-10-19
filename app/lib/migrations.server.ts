import type { PrismaClient } from "@prisma/client";

// Database migrations, applied by the app itself on its first request in each
// serverless instance (Netlify only gives the app the database address while
// it runs, not during the build). Each environment migrates its own schema
// (DB_SCHEMA), and an advisory lock keeps two instances from migrating at once.
//
// To change the database: edit prisma/schema.prisma, then add a migration
// whose SQL comes from `npx prisma migrate diff --from-schema-datamodel
// <old schema> --to-schema-datamodel prisma/schema.prisma --script`.
// Never edit a migration that has already run.
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "20261015180000_init",
    sql: `
-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WmsConnection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WmsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WmsComparison" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skus" TEXT,
    "found" TEXT,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "results" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WmsComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogScan" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "objectCount" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "rows" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CatalogScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WmsConnection_shop_provider_key" ON "WmsConnection"("shop", "provider");

-- CreateIndex
CREATE INDEX "WmsComparison_shop_provider_startedAt_idx" ON "WmsComparison"("shop", "provider", "startedAt");

-- CreateIndex
CREATE INDEX "CatalogScan_shop_startedAt_idx" ON "CatalogScan"("shop", "startedAt");


-- SKU Doctor only connects as the database owner. Row level security with no
-- policies keeps any other role (e.g. a database Data API, if one is ever
-- enabled) from reading sessions or warehouse credentials.
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsComparison" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogScan" ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    name: "20261016120000_comparison_cursor",
    sql: `
ALTER TABLE "WmsComparison" ADD COLUMN "cursor" TEXT;
`,
  },
  {
    name: "20261019120000_fixes_and_sync",
    sql: `
-- CreateTable
CREATE TABLE "FixBatch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "comparisonId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "reverted" INTEGER NOT NULL DEFAULT 0,
    "kept" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "FixBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "oldValue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,

    CONSTRAINT "FixItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "fixFields" TEXT NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'idle',
    "scanId" TEXT,
    "comparisonId" TEXT,
    "fixBatchId" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixBatch_shop_provider_createdAt_idx" ON "FixBatch"("shop", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "FixItem_batchId_status_idx" ON "FixItem"("batchId", "status");

-- CreateIndex
CREATE INDEX "FixItem_shop_idx" ON "FixItem"("shop");

-- CreateIndex
CREATE INDEX "SyncSetting_enabled_nextRunAt_idx" ON "SyncSetting"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncSetting_shop_provider_key" ON "SyncSetting"("shop", "provider");

ALTER TABLE "FixBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncSetting" ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    name: "20261019180000_sync_runs",
    sql: `
-- AlterTable
ALTER TABLE "SyncSetting" ADD COLUMN     "runId" TEXT;

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "comparisonId" TEXT,
    "fixBatchId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncRun_shop_startedAt_idx" ON "SyncRun"("shop", "startedAt");

ALTER TABLE "SyncRun" ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    name: "20261020120000_catalog_rows",
    sql: `
-- Old-format catalog scans and comparisons can't be converted; pages start a
-- new scan automatically. Fix history, connections and sync settings are kept.
DELETE FROM "CatalogScan";
DELETE FROM "WmsComparison";
UPDATE "SyncSetting" SET "stage" = 'idle', "scanId" = NULL, "comparisonId" = NULL, "fixBatchId" = NULL, "runId" = NULL;
UPDATE "SyncRun" SET "status" = 'failed', "message" = 'Interrupted by an update', "finishedAt" = CURRENT_TIMESTAMP WHERE "status" = 'running';
-- AlterTable
ALTER TABLE "WmsComparison" DROP COLUMN "found",
DROP COLUMN "results",
DROP COLUMN "skus",
ADD COLUMN     "mismatchCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowCursor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "scanId" TEXT NOT NULL,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "skuCursor" TEXT,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'lookup';

-- AlterTable
ALTER TABLE "CatalogScan" DROP COLUMN "rows",
ADD COLUMN     "fileSize" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "importOffset" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "url" TEXT;

-- AlterTable
ALTER TABLE "SyncSetting" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "WmsFound" (
    "id" BIGSERIAL NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "skuKey" TEXT NOT NULL,
    "data" TEXT NOT NULL,

    CONSTRAINT "WmsFound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WmsMismatch" (
    "id" BIGSERIAL NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "shopify" TEXT NOT NULL,
    "wms" TEXT NOT NULL,
    "target" TEXT,

    CONSTRAINT "WmsMismatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "id" BIGSERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sku" TEXT,
    "skuKey" TEXT,
    "barcode" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "compareAtPrice" DOUBLE PRECISION,
    "cost" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "weightUnit" TEXT,
    "requiresShipping" BOOLEAN NOT NULL,
    "inventoryQuantity" INTEGER,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WmsFound_comparisonId_skuKey_key" ON "WmsFound"("comparisonId", "skuKey");

-- CreateIndex
CREATE INDEX "WmsMismatch_comparisonId_code_id_idx" ON "WmsMismatch"("comparisonId", "code", "id");

-- CreateIndex
CREATE INDEX "WmsMismatch_comparisonId_variantId_idx" ON "WmsMismatch"("comparisonId", "variantId");

-- CreateIndex
CREATE INDEX "WmsMismatch_shop_idx" ON "WmsMismatch"("shop");

-- CreateIndex
CREATE INDEX "CatalogVariant_scanId_id_idx" ON "CatalogVariant"("scanId", "id");

-- CreateIndex
CREATE INDEX "CatalogVariant_scanId_skuKey_idx" ON "CatalogVariant"("scanId", "skuKey");

-- CreateIndex
CREATE INDEX "CatalogVariant_scanId_variantId_idx" ON "CatalogVariant"("scanId", "variantId");

-- CreateIndex
CREATE INDEX "CatalogVariant_shop_idx" ON "CatalogVariant"("shop");

ALTER TABLE "WmsFound" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsMismatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogVariant" ENABLE ROW LEVEL SECURITY;
`,
  },
];

const statements = (sql: string) =>
  sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim().replace(/;$/, ""))
    .filter(Boolean);

export async function migrate(prisma: PrismaClient) {
  const schema = process.env.DB_SCHEMA;
  if (schema) {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, "")}"`);
  }

  await prisma.$transaction(
    async (tx) => {
      // Any fixed number works; it only has to be the same for every instance.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(724113)");
      await tx.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "_app_migrations" (
          "name" TEXT PRIMARY KEY,
          "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
      await tx.$executeRawUnsafe('ALTER TABLE "_app_migrations" ENABLE ROW LEVEL SECURITY');
      const done = new Set(
        (await tx.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM "_app_migrations"')).map(
          (r) => r.name,
        ),
      );
      for (const migration of MIGRATIONS) {
        if (done.has(migration.name)) continue;
        for (const statement of statements(migration.sql)) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO "_app_migrations" ("name") VALUES ($1)',
          migration.name,
        );
        console.log(`Applied database migration ${migration.name}`);
      }
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}
