import { PrismaClient } from "@prisma/client";

// Netlify Database provides NETLIFY_DB_URL (older setups used other names).
// A PgBouncer pooler URL needs pgbouncer mode, each serverless function
// instance only needs one connection, and DB_SCHEMA keeps the dev app's tables
// apart from the public app's (see scripts/migrate.mjs).
function databaseUrl() {
  const raw =
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.hostname.includes("-pooler")) url.searchParams.set("pgbouncer", "true");
  if (process.env.DB_SCHEMA) url.searchParams.set("schema", process.env.DB_SCHEMA);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", "1");
  }
  return url.toString();
}

// The schema's directUrl is only used by migrations, but Prisma still reads it.
process.env.NETLIFY_DB_URL_UNPOOLED ||= databaseUrl() ?? "";

const createClient = () => new PrismaClient({ datasourceUrl: databaseUrl() });

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
