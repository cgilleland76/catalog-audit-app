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
