// Text shared by the public pages (/support, /updates, /privacy) and the
// in-app Support and Updates pages. Add new releases to the top of UPDATES.

export type Update = {
  date: string; // YYYY-MM-DD
  title: string;
  items: string[];
};

/** Planned features, shown above the release notes. Move to UPDATES when shipped. */
export const UPCOMING: { title: string; description: string }[] = [];

export const UPDATES: Update[] = [
  {
    date: "2026-10-20",
    title: "Large catalogs, plan limits and the active/draft filter",
    items: [
      "Catalogs of any size: SKU Doctor now saves your catalog one variant at a time and reads it in small steps, so pages load quickly even with hundreds of thousands of variants.",
      "Plan limits: Free covers up to 500 active and draft variants, Pro up to 10,000 and Warehouse up to 100,000. Larger catalogs are audited and compared up to the limit.",
      "Archived products are no longer read, audited or compared. If one becomes active or draft again, the next scan picks it up.",
      "Warehouse comparisons and scheduled syncs can cover active products only, or active and draft products.",
      "Scheduled syncs now run in the background for each store, so long runs finish without the app open.",
    ],
  },
  {
    date: "2026-10-19",
    title: "Fix in Shopify, Undo, scheduled sync and History",
    items: [
      "Fix in Shopify: after a warehouse comparison, choose weight, cost and/or barcode, preview the changes and copy your warehouse's values into Shopify.",
      "Undo: every fix saves Shopify's old values for 90 days. Undo puts them back for a whole run or just the changes you select, leaving alone anything changed in Shopify since.",
      "History: a new page listing every comparison and fix, manual or scheduled, and every value SKU Doctor changed (before and after), with CSV export.",
      "Scheduled sync: compare with your warehouse every 6 hours, daily or weekly, even when SKU Doctor isn't open, and optionally fix chosen fields automatically.",
      "SKU Doctor now asks for permission to edit products and inventory items, which fixing needs. It still changes nothing unless you choose Fix or set up a scheduled sync that fixes.",
    ],
  },
  {
    date: "2026-10-17",
    title: "Cin7 Core and Veeqo",
    items: [
      "Warehouse comparison now works with Cin7 Core: weight, barcode and cost (average cost, or the supplier price) are checked against Shopify.",
      "Warehouse comparison now works with Veeqo: weight, barcode (UPC) and cost price are checked against Shopify.",
    ],
  },
  {
    date: "2026-10-16",
    title: "ShipBob and multiple warehouses",
    items: [
      "Warehouse comparison now works with ShipBob: weight, barcode and cost (ShipBob's customs value) are checked against Shopify.",
      "The Warehouse page lists every supported system. Choose Connect to set one up, and connect as many as you use; each is compared on its own.",
    ],
  },
  {
    date: "2026-10-15",
    title: "SKU Doctor 1.0",
    items: [
      "Catalog audit: flags prices below cost, $0 prices, duplicate SKUs and barcodes, missing weights, costs, SKUs and images, low margins, and compare-at prices that aren't above the price.",
      "Wholesale line sheets: pick products by vendor, type or tag, price them as a percent of retail or a markup on cost, and export a print-ready PDF or a spreadsheet.",
      "Warehouse comparison with ShipHero: checks every SKU's weight, cost and barcode against your warehouse and lists SKUs it doesn't know.",
      "Your catalog is read in the background with a live progress counter, so even large catalogs never leave you on a blank page.",
    ],
  },
];

export type FaqEntry = { question: string; answer: string };

export const FAQ: FaqEntry[] = [
  {
    question: "Does SKU Doctor change my products?",
    answer:
      "Only when you ask it to. Audits, line sheets and comparisons only read your catalog. Fix in Shopify (or a scheduled sync you set to fix) copies the weights, costs or barcodes you choose from your warehouse into Shopify, after keeping the old values so you can undo it. Your warehouse system is never changed.",
  },
  {
    question: "How long does a catalog scan take?",
    answer:
      "Most stores finish in under two minutes. The page shows how many variants have been read so far, and you can leave and come back while it runs.",
  },
  {
    question: "Why does the warehouse comparison take longer?",
    answer:
      "Warehouse systems limit how fast apps can look up products. SKU Doctor checks your SKUs in batches and pauses when asked to, so a large catalog can take several minutes. Keep the Warehouse page open while it runs; it picks up where it left off if you leave.",
  },
  {
    question: "How do I connect a warehouse system?",
    answer:
      "Open Warehouse and choose Connect next to your system. For ShipHero, paste an API refresh token (and your customer account ID if your warehouse is a 3PL). For ShipBob, paste a Personal Access Token from Integrations → API Tokens. For Cin7 Core, create an API application under Integrations → API and paste its Account ID and Application Key. For Veeqo, go to Settings → Users, edit your user and choose Refresh API Key (if there's no API Key section, Veeqo support has to enable API access first). Then choose Test and connect. Tokens are stored encrypted, and you can connect more than one system.",
  },
  {
    question: "What happens to my data if I uninstall?",
    answer:
      "Everything SKU Doctor stored for your store — catalog scans, comparison results and warehouse credentials — is deleted when you uninstall.",
  },
];

/** Contact address for support, set per site with the SUPPORT_EMAIL variable. */
export const supportEmail = () => process.env.SUPPORT_EMAIL?.trim() || null;
