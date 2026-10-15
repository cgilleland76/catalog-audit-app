# SKU Doctor

Catalog audit and wholesale line sheets for Shopify.

An embedded Shopify app with two tools:

- **Catalog audit** — scans every product variant and flags problems:
  - Critical: price below cost, $0 price, duplicate SKU, missing weight on shippable items
  - Warning: missing SKU or cost, margin under your target, duplicate barcode, compare-at price not above price
  - Info: missing barcode or product image

  Filter by issue, search, jump straight to the variant in the admin, and export the list as CSV.
- **Line sheet** — pick products by vendor, type or tag, set wholesale pricing (percent of retail or cost × markup), add your header and terms, then open a print-ready page to save as PDF, or download a CSV for Excel.

The app is read-only: it requests `read_products` and `read_inventory` and never changes your catalog.

## Run it on your store

Requires Node 22.12+ and a Shopify Partner / developer account.

```sh
npm install
npm run dev        # signs in, creates/links the app, opens a tunnel
```

Press `p` in the dev console to open the app in your store and approve the install.

## Notes

- Built from Shopify's React Router app template (`TEMPLATE_README.md` covers deployment and the framework).
- Catalog data is fetched with paged `productVariants` queries (100 per page, up to 20,000 variants). Very large catalogs should move to bulk operations.
- Prices on the line sheet are shown in USD.
