#!/usr/bin/env node
/* eslint-env node */
/**
 * Copy secrets from a local, gitignored env file to ONE Netlify site, without printing any value.
 *
 *   npm run env:push -- <sku-doctor|sku-doctor-dev> [file]       e.g.  npm run env:push -- sku-doctor .env.prod
 *
 * [file] defaults to .env. Only keys listed in KEYS that have a value in the file are pushed; everything else
 * on the site is left alone. Needs a one-time `npx netlify-cli login` (click Authorize). Redeploy afterwards.
 *
 * CREDENTIALS_KEY is skipped unless you pass --allow-credentials-key: changing it on a site that already stores
 * warehouse credentials makes them unreadable (see docs/environment.md).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITES = {
  "sku-doctor": "d66c315b-00ba-4715-b917-502934d8ee2d", // public app (main)
  "sku-doctor-dev": "6492187a-7d8d-44a1-b4b9-d406e7dd794a", // dev app (dev)
};
const KEYS = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "SHOPIFY_APP_HANDLE",
  "SUPPORT_EMAIL",
  "PLAN_OVERRIDE",
  "DB_SCHEMA",
  "CREDENTIALS_KEY",
];

const args = process.argv.slice(2);
const allowCredentialsKey = args.includes("--allow-credentials-key");
const [site, file = ".env"] = args.filter((a) => !a.startsWith("--"));
if (!SITES[site]) {
  console.error(`[env-push] Usage: npm run env:push -- <${Object.keys(SITES).join("|")}> [env file] [--allow-credentials-key]`);
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`[env-push] ${file} not found. Create it (gitignored) with the values for ${site}.`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")];
    }),
);
const skipped = [];
const pushed = KEYS.filter((k) => {
  if (!env[k]?.trim()) return false;
  if (k === "PLAN_OVERRIDE" && site === "sku-doctor") {
    console.error("[env-push] PLAN_OVERRIDE is for the Dev site only; not pushing it to sku-doctor.");
    return false;
  }
  if (k === "CREDENTIALS_KEY" && !allowCredentialsKey) {
    skipped.push(k);
    return false;
  }
  return true;
});
if (!pushed.length) {
  console.error(`[env-push] Nothing to push from ${file}.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "skudoctor-env-"));
const tmp = join(dir, "netlify.env");
try {
  writeFileSync(tmp, pushed.map((k) => `${k}="${env[k].trim()}"`).join("\n") + "\n", { mode: 0o600 });
  execFileSync("npx", ["-y", "netlify-cli@latest", "env:import", tmp, "--site", SITES[site]], {
    stdio: ["ignore", "ignore", "inherit"], // the CLI echoes values on stdout; keep them off the screen
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`[env-push] ${site}: pushed ${pushed.join(", ")}`);
if (skipped.length) console.log(`[env-push] Skipped ${skipped.join(", ")} (needs --allow-credentials-key; read docs/environment.md first)`);
console.log("[env-push] Redeploy the site for the new values to take effect.");
