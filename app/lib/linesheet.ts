import type { CatalogRow } from "./catalog";

/** Filter value meaning "any". */
export const ALL = "__all__";

export type LineSheetFilters = {
  vendor: string;
  productType: string;
  tag: string;
  includeDrafts: boolean;
  hideOutOfStock: boolean;
};

export type PricingMode = "percent_of_retail" | "cost_markup";

export type LineSheetSettings = {
  title: string;
  company: string;
  contact: string;
  terms: string;
  pricingMode: PricingMode;
  percentOfRetail: number;
  costMarkup: number;
  showMsrp: boolean;
  showStock: boolean;
};

export type LineSheetProduct = {
  productId: string;
  title: string;
  vendor: string;
  productType: string;
  imageUrl: string | null;
  variants: {
    variantId: string;
    title: string;
    sku: string | null;
    msrp: number;
    wholesale: number | null;
    stock: number | null;
  }[];
};

export function wholesalePrice(row: CatalogRow, s: LineSheetSettings) {
  if (s.pricingMode === "cost_markup") {
    return row.cost === null ? null : round2(row.cost * s.costMarkup);
  }
  return round2(row.price * (s.percentOfRetail / 100));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function groupProducts(
  rows: CatalogRow[],
  s: LineSheetSettings,
): LineSheetProduct[] {
  const byProduct = new Map<string, LineSheetProduct>();
  for (const r of rows) {
    let p = byProduct.get(r.productId);
    if (!p) {
      p = {
        productId: r.productId,
        title: r.productTitle,
        vendor: r.vendor,
        productType: r.productType,
        imageUrl: r.imageUrl,
        variants: [],
      };
      byProduct.set(r.productId, p);
    }
    p.variants.push({
      variantId: r.variantId,
      title: r.variantTitle === "Default Title" ? "" : r.variantTitle,
      sku: r.sku,
      msrp: r.price,
      wholesale: wholesalePrice(r, s),
      stock: r.inventoryQuantity,
    });
  }
  return [...byProduct.values()];
}

const esc = (v: string | number | null | undefined) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

// A standalone, print-ready page. The merchant saves it as PDF from the
// browser's print dialog, which keeps images sharp and needs no PDF library.
export function lineSheetHtml(products: LineSheetProduct[], s: LineSheetSettings) {
  const cards = products
    .map((p) => {
      const rows = p.variants
        .map(
          (v) => `<tr>
            <td>${esc(v.title || "—")}</td>
            <td>${esc(v.sku || "—")}</td>
            <td class="num">${money(v.wholesale)}</td>
            ${s.showMsrp ? `<td class="num">${money(v.msrp)}</td>` : ""}
            ${s.showStock ? `<td class="num">${v.stock ?? "—"}</td>` : ""}
          </tr>`,
        )
        .join("");
      return `<article class="card">
        <div class="img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="">` : "<span>No image</span>"}</div>
        <h2>${esc(p.title)}</h2>
        <p class="meta">${esc([p.vendor, p.productType].filter(Boolean).join(" · "))}</p>
        <table>
          <thead><tr><th>Option</th><th>SKU</th><th class="num">Wholesale</th>${s.showMsrp ? '<th class="num">MSRP</th>' : ""}${s.showStock ? '<th class="num">Stock</th>' : ""}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(s.title || "Line sheet")}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font: 11px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 24px; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; margin-bottom: 16px; }
  header h1 { font-size: 22px; margin: 0; }
  header .co { font-size: 13px; font-weight: 600; }
  header .right { text-align: right; color: #555; white-space: pre-line; }
  .terms { color: #555; margin: 0 0 16px; white-space: pre-line; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { break-inside: avoid; border: 1px solid #ddd; border-radius: 6px; padding: 10px; }
  .img { aspect-ratio: 1; background: #f4f4f4; display: flex; align-items: center; justify-content: center; margin-bottom: 8px; overflow: hidden; border-radius: 4px; }
  .img img { width: 100%; height: 100%; object-fit: contain; }
  .img span { color: #999; }
  h2 { font-size: 12px; margin: 0 0 2px; }
  .meta { color: #666; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { text-align: left; padding: 2px 3px; border-top: 1px solid #eee; }
  th { color: #666; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 16px; color: #888; font-size: 10px; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <header>
    <div><div class="co">${esc(s.company)}</div><h1>${esc(s.title || "Wholesale line sheet")}</h1></div>
    <div class="right">${esc(s.contact)}</div>
  </header>
  ${s.terms ? `<p class="terms">${esc(s.terms)}</p>` : ""}
  <div class="grid">${cards}</div>
  <footer>${products.length} styles · Prices in USD · Generated ${esc(new Date().toLocaleDateString())}</footer>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>`;
}
