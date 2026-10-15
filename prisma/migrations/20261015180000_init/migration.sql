-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
