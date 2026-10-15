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

## Hosting

Runs on **Netlify** (Functions) with **Netlify DB** (Neon Postgres).

- The `@netlify/neon` dependency tells Netlify to provision the database, which sets `NETLIFY_DATABASE_URL` (pooled, used by the app) and `NETLIFY_DATABASE_URL_UNPOOLED` (used by migrations). Claim the database into a Neon account from the Netlify dashboard so it isn't removed.
- `netlify.toml` builds the app, runs `prisma migrate deploy`, and bundles Prisma's Linux engine.
- Netlify Functions stop after a few seconds, so long work advances in steps while a page is open: catalog scans finish when a page checks on them, and ShipHero comparisons look up the next SKUs on each step (`advanceComparison`).

Netlify environment variables to set yourself: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (the Netlify site URL), `SCOPES` (`read_products,read_inventory`), `CREDENTIALS_KEY`.

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
