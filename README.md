# SKU Doctor

Catalog audit and wholesale line sheets for Shopify.

An embedded Shopify app with two tools:

- **Catalog audit** — scans every product variant and flags problems:
  - Critical: price below cost, $0 price, duplicate SKU, missing weight on shippable items
  - Warning: missing SKU or cost, margin under your target, duplicate barcode, compare-at price not above price
  - Info: missing barcode or product image

  Filter by issue, search, jump straight to the variant in the admin, and export the list as CSV.
- **Line sheet** — pick products by vendor, type or tag, set wholesale pricing (percent of retail or cost × markup), add your header and terms, then open a print-ready page to save as PDF, or download a CSV for Excel.

- **Warehouse comparison** — connect your WMS (ShipHero today) and check every Shopify SKU against it: weight, cost and barcode differences, plus SKUs the warehouse doesn't know. Runs in the background; results can be exported as CSV. Kits without their own weight or cost use the sum of their components.

The app is read-only: it requests `read_products` and `read_inventory` and never changes your catalog.

## Plans and billing

Billing uses Shopify App Pricing: the plans are set up in the Dev Dashboard (app → Pricing), and Shopify hosts the plan picker and invoices merchants.

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | Catalog audit for up to 500 variants |
| Pro | $14.99/month | Unlimited audit, line sheets |
| Warehouse | $39/month | Pro + warehouse comparison |

Paid plans have a 14-day free trial and are billed monthly. The app reads the shop's active plan by name (`app/lib/plans.server.ts`), so plan names in the dashboard must contain "Pro" and "Warehouse". The dev app has no App Store pricing: set `PLAN_OVERRIDE=warehouse` on the `sku-doctor-dev` site to unlock everything there (never on the public site). Set `SHOPIFY_APP_HANDLE` on each Netlify site (`sku-doctor-app` / `sku-doctor-dev`) so the "See plans" buttons open the right app's plan picker.

## Support, updates and privacy

- Public pages: `/support`, `/updates` and `/privacy` on each site; in the app, **Updates** and **Support** in the nav. Text lives in `app/lib/site-content.ts` — add each release to the top of `UPDATES`.
- Set `SUPPORT_EMAIL` on each Netlify site to show the contact address.
- Uninstalling deletes all of a shop's data; the mandatory privacy webhooks are handled in `app/routes/webhooks.compliance.tsx`.

## Hosting

Runs on **Netlify** (Functions) with **Netlify Database** (built-in Postgres), created from the project's Database page. Netlify provides the connection string as `NETLIFY_DB_URL`; `app/db.server.ts` also accepts the older `NETLIFY_DATABASE_URL` name.
- Netlify only gives the running app the database address, not the build, so the app creates and updates its own tables on its first request in each instance (`app/lib/migrations.server.ts`, guarded by an advisory lock). `netlify.toml` builds the app and bundles Prisma's Linux engine.
- Netlify Functions stop after a few seconds, so long work advances in steps while a page is open: catalog scans finish when a page checks on them, and ShipHero comparisons look up the next SKUs on each step (`advanceComparison`).

Netlify environment variables to set yourself: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (the Netlify site URL), `SCOPES` (`read_products,read_inventory`), `CREDENTIALS_KEY`.

### Environment variables

Required variables, the build-time check, `npm run env:push` and the `CREDENTIALS_KEY` caveat: [docs/environment.md](docs/environment.md).

## Dev and public apps

Two Netlify sites build this one repo, each with its own Netlify Database:

| | Dev | Public |
|---|---|---|
| Shopify app | SKU Doctor Dev (`shopify.app.dev.toml`) | SKU Doctor (`shopify.app.toml`) |
| Netlify site | `sku-doctor-dev` (production branch: `dev`) | `sku-doctor` (production branch: `main`) |
| Address | `https://sku-doctor-dev.netlify.app` | `https://skudoctor.thirdaxiscustoms.com` (custom domain on the `sku-doctor` site) |

Each site has its own environment variables (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `CREDENTIALS_KEY`) for its Shopify app. `DB_SCHEMA` is optional and only needed if two apps ever share one database.

**Releasing a change:** commit to `dev`, check it in SKU Doctor Dev, then merge `dev` into `main`. If a change touches the app config (scopes, URLs, webhooks), also run `npm run deploy -- --config dev` for dev and `npm run deploy` for public.

## Run it locally

Requires Node 22.12+, a Shopify Partner / developer account, and a `.env` file (copy `.env.example`).

```sh
npm install
npm run dev        # signs in, links the app, opens a tunnel
```

Press `p` in the dev console to open the app in your store and approve the install.

## Adding another warehouse system

Write a connector in `app/lib/wms/` that implements `WmsProvider` (`types.ts`) — credential fields, a connection test, and a SKU lookup returning weight in pounds and cost — then register it in `PROVIDERS` in `app/lib/wms/index.server.ts`. `shiphero.server.ts` is the reference.

Warehouse credentials are stored AES-256-GCM encrypted. Set `CREDENTIALS_KEY` to the same value everywhere (Netlify and your `.env`); without it the key is derived from the app's API secret.

## Notes

- Built from Shopify's React Router app template (`TEMPLATE_README.md` covers deployment and the framework).
- The catalog is read with a Shopify bulk operation in the background and saved per shop (`CatalogScan`). All pages work from the latest scan, show progress while one runs, and the first scan starts automatically.
- Prices on the line sheet are shown in USD.
