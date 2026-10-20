# Environment variables and secrets

Two Netlify sites build this repo: `sku-doctor` (from `main`, public app) and `sku-doctor-dev` (from `dev`).
Each has its own Netlify Database, which Netlify connects automatically (`NETLIFY_DB_URL`); never set the
database URL by hand on Netlify.

## Variables

| Name | Required | Notes |
| --- | --- | --- |
| `SHOPIFY_API_KEY` | yes | Client ID of the site's Shopify app |
| `SHOPIFY_API_SECRET` | yes | Client secret. Secret |
| `SHOPIFY_APP_URL` | yes | The site's URL |
| `SCOPES` | yes | Must match the app's TOML: `read_products,write_products,read_inventory,write_inventory` |
| `SHOPIFY_APP_HANDLE` | no | Defaults to `sku-doctor-app`; used for the plan-selection link |
| `SUPPORT_EMAIL` | no | Defaults to `support@thirdaxiscustoms.com` |
| `PLAN_OVERRIDE` | dev only | Fixes the plan on the dev app (no App Store pricing there) |
| `WMS_PREVIEW` | dev only | `1` lists warehouse systems not yet tested with a real account (ShipBob, Cin7 Core). Never set it on the public site |
| `DB_SCHEMA` | no | Keeps a site's tables in their own schema |
| `CREDENTIALS_KEY` | see below | Encrypts stored warehouse credentials. Secret |

## Build-time check

Every Netlify build starts with `scripts/check-env.mjs`. It stops the build and lists any missing required
variable **names** (never values), and warns when `CREDENTIALS_KEY` is not set. Run it locally with
`npm run env:check`.

## Setting or changing secrets

Don't paste secrets into the Netlify UI. Put them in a gitignored file (`.env`, `.env.prod`, …) and run:

```
npx netlify-cli login                          # once per machine; click Authorize in the browser
npm run env:push -- sku-doctor .env.prod        # or sku-doctor-dev
```

Then redeploy the site. Values are never printed.

## CREDENTIALS_KEY: read before changing

`app/lib/crypto.server.ts` encrypts warehouse credentials with `CREDENTIALS_KEY`, or with `SHOPIFY_API_SECRET`
when `CREDENTIALS_KEY` is not set.

- On a site that has never stored credentials, set `CREDENTIALS_KEY` before the first merchant connects a warehouse.
- On a site that already stores credentials encrypted with the fallback, **adding or changing `CREDENTIALS_KEY`
  (or rotating `SHOPIFY_API_SECRET`) makes them unreadable.** Re-encrypt them first (decrypt with the old
  secret, encrypt with the new key), or have merchants re-enter them.
- `env:push` skips `CREDENTIALS_KEY` unless you pass `--allow-credentials-key`.
