import { PrismaClient } from "@prisma/client";

import { migrate } from "./lib/migrations.server";

// Netlify Database provides NETLIFY_DB_URL (older setups used other names).
// A PgBouncer pooler URL needs pgbouncer mode, each serverless function
// instance only needs one connection, and DB_SCHEMA keeps the dev app's tables
// apart from the public app's (see app/lib/migrations.server.ts).
function databaseUrl() {
  const raw =
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  // Neon (ep-…-pooler) and Supabase's transaction pooler (port 6543) run PgBouncer.
  if (url.hostname.includes("-pooler") || url.port === "6543") {
    url.searchParams.set("pgbouncer", "true");
  }
  if (process.env.DB_SCHEMA) url.searchParams.set("schema", process.env.DB_SCHEMA);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", "1");
  }
  // An idle Netlify Database sleeps and takes a few seconds to wake; Prisma's
  // default 5 s connect timeout gave up first. Two tries of 10 s (see
  // databaseReady) stay inside Netlify's ~26 s request limit.
  if (!url.searchParams.has("connect_timeout")) {
    url.searchParams.set("connect_timeout", "10");
  }
  // Wait for the pool's one connection longer than connecting may take, so a
  // slow wake ends as "unreachable" (retried) rather than a pool timeout.
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", "20");
  }
  return url.toString();
}

function createClient() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "No database connection string. Netlify provides NETLIFY_DB_URL to a site's " +
        "production deploys once the site has a database (project → Database).",
    );
  }
  // prisma/schema.prisma names NETLIFY_DB_URL; keep it set for Prisma's checks.
  process.env.NETLIFY_DB_URL ||= url;
  return new PrismaClient({ datasourceUrl: url });
}

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "Can't reach database server" (P1001) or no connection in time (P2024):
// usually a sleeping database still waking.
const WAKING = new Set(["P1001", "P2024"]);
const unreachable = (error: unknown) => {
  const e = error as { errorCode?: string; code?: string } | null;
  return WAKING.has(e?.errorCode ?? "") || WAKING.has(e?.code ?? "");
};

async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await migrate(prisma);
    } catch (error) {
      if (!unreachable(error) || attempt >= 2) throw error;
      console.warn("[db] database not reachable yet; retrying once");
      await sleep(1000);
    }
  }
}

// Creates or updates the tables once per server instance before first use.
let migrated: Promise<void> | undefined;
export function databaseReady() {
  migrated ??= migrateWithRetry().catch((error) => {
    migrated = undefined; // try again on the next request
    throw error;
  });
  return migrated;
}
