// Applies database migrations during the Netlify build. Each environment
// keeps its tables in its own Postgres schema (DB_SCHEMA, e.g. "dev"), so the
// dev and public apps can share one Netlify DB without sharing data.
import { execSync } from "node:child_process";

const env = { ...process.env };
const schema = env.DB_SCHEMA;
if (schema) {
  for (const key of ["NETLIFY_DATABASE_URL", "NETLIFY_DATABASE_URL_UNPOOLED"]) {
    if (!env[key]) continue;
    const url = new URL(env[key]);
    url.searchParams.set("schema", schema);
    env[key] = url.toString();
  }
}

console.log(`Applying migrations to schema "${schema || "public"}"`);
execSync("npx prisma migrate deploy", { stdio: "inherit", env });
