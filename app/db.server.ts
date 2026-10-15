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

// Creates or updates the tables once per server instance before first use.
let migrated: Promise<void> | undefined;
export function databaseReady() {
  migrated ??= migrate(prisma).catch((error) => {
    migrated = undefined; // try again on the next request
    throw error;
  });
  return migrated;
}
