#!/usr/bin/env node
/* eslint-env node */
/**
 * Fails the build fast, listing missing environment variable NAMES (never values).
 * Runs first in the Netlify build (netlify.toml) on sku-doctor and sku-doctor-dev.
 * Local: `npm run env:check` (reads .env if present).
 *
 * The database (NETLIFY_DB_URL) is provided by Netlify Database at runtime, so it is not checked here.
 */
const REQUIRED = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES"];

const has = (name) => Boolean(process.env[name]?.trim());
const missing = REQUIRED.filter((name) => !has(name));
const where = process.env.SITE_NAME ? ` on Netlify site "${process.env.SITE_NAME}" (${process.env.CONTEXT ?? "?"})` : "";

if (!has("CREDENTIALS_KEY")) {
  // app/lib/crypto.server.ts falls back to SHOPIFY_API_SECRET. Sites that already saved warehouse credentials
  // with that fallback must NOT get a new CREDENTIALS_KEY without re-encrypting them first.
  console.warn(
    `[env-check] CREDENTIALS_KEY is not set${where}; stored credentials are encrypted with SHOPIFY_API_SECRET. ` +
      `Rotating the Shopify API secret would make them unreadable. See docs/environment.md.`,
  );
}
// Test-only variables give paid or untested features away on the public app.
const TEST_ONLY = ["PLAN_OVERRIDE", "WMS_PREVIEW"];
if (process.env.SITE_NAME === "sku-doctor") {
  const set = TEST_ONLY.filter(has);
  if (set.length) {
    console.error(
      `[env-check] ${set.join(", ")} must not be set on the public site "sku-doctor" (Dev site only). Delete it in Netlify and redeploy.`,
    );
    process.exit(1);
  }
}
if (missing.length) {
  console.error(
    `[env-check] Missing required environment variables${where}: ${missing.join(", ")}\n` +
      `[env-check] Fix: npm run env:push -- <site> <env file>  (or set them in Netlify), then retry the deploy.`,
  );
  process.exit(1);
}
console.log(`[env-check] OK${where}: ${REQUIRED.length} required variables set`);
