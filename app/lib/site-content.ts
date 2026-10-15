// Text shared by the public pages (/support, /updates, /privacy) and the
// in-app Support and Updates pages. Add new releases to the top of UPDATES.

export type Update = {
  date: string; // YYYY-MM-DD
  title: string;
  items: string[];
};

export const UPDATES: Update[] = [
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
      "No. SKU Doctor only reads your catalog. Audits, line sheets and warehouse comparisons never change anything in Shopify or your warehouse system.",
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
    question: "How do I connect ShipHero?",
    answer:
      "Open Warehouse, paste a ShipHero API refresh token (and your customer account ID if your warehouse is a 3PL), then choose Test and connect. The token is stored encrypted.",
  },
  {
    question: "What happens to my data if I uninstall?",
    answer:
      "Everything SKU Doctor stored for your store — catalog scans, comparison results and warehouse credentials — is deleted when you uninstall.",
  },
];

/** Contact address for support, set per site with the SUPPORT_EMAIL variable. */
export const supportEmail = () => process.env.SUPPORT_EMAIL?.trim() || null;
