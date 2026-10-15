// Applies database migrations during the Netlify build. Each environment
// keeps its tables in its own Postgres schema (DB_SCHEMA, e.g. "dev"), so the
// dev and public apps can share one database without sharing data.
import { execSync } from "node:child_process";
import { databaseVariableNames, resolveDatabaseUrls } from "./db-url.mjs";

const urls = resolveDatabaseUrls();
if (!urls) {
  const names = databaseVariableNames();
  console.error(
    "\nNo database connection string found, so there is no database to set up.\n" +
      `Database-related variables visible to the build: ${names.length ? names.join(", ") : "none"}\n` +
      "Create the database in Netlify (your project → Database), then redeploy.\n",
  );
  process.exit(1);
}

const schema = process.env.DB_SCHEMA;
const withSchema = (raw) => {
  const url = new URL(raw);
  if (schema) url.searchParams.set("schema", schema);
  return url.toString();
};

console.log(`Using database from ${urls.pooled[0]} / ${urls.direct[0]}`);
console.log(`Applying migrations to schema "${schema || "public"}"`);
execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  env: {
    ...process.env,
    NETLIFY_DATABASE_URL: withSchema(urls.pooled[1]),
    NETLIFY_DATABASE_URL_UNPOOLED: withSchema(urls.direct[1]),
  },
});
