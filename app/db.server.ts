import { PrismaClient } from "@prisma/client";

// Netlify DB's pooled URL goes through PgBouncer, and each serverless function
// instance only needs one connection. DB_SCHEMA keeps the dev app's tables
// apart from the public app's (see scripts/migrate.mjs).
function databaseUrl() {
  const raw = process.env.NETLIFY_DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.hostname.includes("-pooler")) url.searchParams.set("pgbouncer", "true");
  if (process.env.DB_SCHEMA) url.searchParams.set("schema", process.env.DB_SCHEMA);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", "1");
  }
  return url.toString();
}

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
