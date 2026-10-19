import { useMemo, useState, type ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { catalogForPage, planCap } from "../lib/catalog.server";
import {
  LINE_SHEET_MAX,
  lineSheetFilters,
  lineSheetOptions,
  lineSheetRows,
} from "../lib/linesheet.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { PLANS, VARIANT_LIMIT, canUseLineSheets } from "../lib/plans";
import { UpgradeSection } from "../components/Upgrade";
import { downloadFile, toCsv, type CatalogRow } from "../lib/catalog";
import { ScanBanner, ScanProgress, useCatalogScan } from "../components/CatalogScan";
import {
  ALL,
  groupProducts,
  lineSheetHtml,
  type LineSheetFilters,
  type LineSheetSettings,
  type PricingMode,
} from "../lib/linesheet";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await getPlan(session.shop, admin);
  if (!canUseLineSheets(plan)) {
    return { locked: true as const, upgradeUrl: planSelectionUrl(session.shop) };
  }
  const catalog = await catalogForPage(session.shop, admin);
  const filters = lineSheetFilters(request);
  const base = { locked: false as const, ...catalog, plan, filters, max: LINE_SHEET_MAX };
  if (!catalog.scanId || catalog.count === null) return { ...base, sheet: null };

  // Only the plan's share of the catalog, and only the variants matching the filters.
  const cap = await planCap(catalog.scanId, catalog.count, VARIANT_LIMIT[plan]);
  const [options, matched] = await Promise.all([
    lineSheetOptions(catalog.scanId, cap.maxId),
    lineSheetRows(catalog.scanId, filters, cap.maxId),
  ]);
  return { ...base, sheet: { ...options, ...matched, cap: { limit: cap.limit, over: cap.over } } };
};

type Loaded = Extract<ReturnType<typeof useLoaderData<typeof loader>>, { locked: false }>;

export default function LineSheetPage() {
  const data = useLoaderData<typeof loader>();
  if (data.locked) {
    return (
      <s-page heading="Line sheet">
        <UpgradeSection feature="Line sheets" needs="pro" upgradeUrl={data.upgradeUrl} />
      </s-page>
    );
  }
  return <LineSheetLoaded {...data} />;
}

function LineSheetLoaded(data: Loaded) {
  const { scan, running, rescan } = useCatalogScan(data.scan, data.scannedAt);

  if (!data.sheet) {
    return (
      <s-page heading="Line sheet">
        <ScanProgress scan={scan} onRetry={rescan} />
      </s-page>
    );
  }
  return (
    <LineSheetBuilder
      data={data}
      sheet={data.sheet}
      banner={<ScanBanner scan={scan} scannedAt={data.scannedAt} onRetry={rescan} />}
      running={running}
      rescan={rescan}
    />
  );
}

function LineSheetBuilder({
  data,
  sheet,
  banner,
  running,
  rescan,
}: {
  data: Loaded;
  sheet: NonNullable<Loaded["sheet"]>;
  banner: ReactNode;
  running: boolean;
  rescan: () => void;
}) {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const { filters } = data;
  const { rows: rawRows, vendors, types, tags } = sheet;
  // Loader data arrives as JSON; the rows are plain catalog rows.
  const rows = rawRows as CatalogRow[];

  // Filters live in the address, so the server sends only matching variants.
  const filter = (change: Partial<LineSheetFilters>) => {
    const next = { ...filters, ...change };
    const qs = new URLSearchParams();
    if (next.vendor !== ALL) qs.set("vendor", next.vendor);
    if (next.productType !== ALL) qs.set("type", next.productType);
    if (next.tag !== ALL) qs.set("tag", next.tag);
    if (next.includeDrafts) qs.set("drafts", "1");
    if (next.hideOutOfStock) qs.set("instock", "1");
    navigate(`/app/linesheet${qs.size ? `?${qs}` : ""}`, { preventScrollReset: true });
  };

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<LineSheetSettings>({
    title: "Wholesale line sheet",
    company: "",
    contact: "",
    terms: "",
    pricingMode: "percent_of_retail",
    percentOfRetail: 50,
    costMarkup: 2,
    showMsrp: true,
    showStock: false,
  });
  const update = <K extends keyof LineSheetSettings>(
    key: K,
    value: LineSheetSettings[K],
  ) => setSettings((s) => ({ ...s, [key]: value }));

  const products = useMemo(() => groupProducts(rows, settings), [rows, settings]);
  const selected = products.filter((p) => !excluded.has(p.productId));
  const missingCost =
    settings.pricingMode === "cost_markup"
      ? selected.flatMap((p) => p.variants).filter((v) => v.wholesale === null)
          .length
      : 0;

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openPdf = () => {
    if (selected.length === 0) {
      shopify.toast.show("Select at least one product", { isError: true });
      return;
    }
    const html = lineSheetHtml(selected, settings);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const win = window.open(url, "_blank");
    if (!win) {
      shopify.toast.show("Allow pop-ups to open the line sheet", {
        isError: true,
      });
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const exportCsv = () => {
    const header = ["Product", "Option", "SKU", "Vendor", "Type", "Wholesale"];
    if (settings.showMsrp) header.push("MSRP");
    if (settings.showStock) header.push("Stock");
    header.push("Image URL");
    const lines = selected.flatMap((p) =>
      p.variants.map((v) => {
        const line: (string | number | null)[] = [
          p.title,
          v.title,
          v.sku,
          p.vendor,
          p.productType,
          v.wholesale,
        ];
        if (settings.showMsrp) line.push(v.msrp);
        if (settings.showStock) line.push(v.stock);
        line.push(p.imageUrl);
        return line;
      }),
    );
    downloadFile(
      `line-sheet-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(header, lines),
      "text/csv;charset=utf-8",
    );
  };

  return (
    <s-page heading="Line sheet">
      <s-button slot="primary-action" variant="primary" onClick={openPdf}>
        Open printable PDF
      </s-button>
      <s-button slot="secondary-actions" onClick={exportCsv}>
        Download spreadsheet (CSV)
      </s-button>
      <s-button slot="secondary-actions" onClick={rescan} disabled={running}>
        Refresh products
      </s-button>

      {banner}
      {sheet.cap.over && (
        <s-banner tone="info" heading={`Using your first ${sheet.cap.limit.toLocaleString()} variants`}>
          The {PLANS[data.plan].name} plan covers up to {sheet.cap.limit.toLocaleString()} active
          and draft variants; your catalog has {(data.count ?? 0).toLocaleString()}. The Warehouse
          plan covers up to {VARIANT_LIMIT.warehouse.toLocaleString()}.
        </s-banner>
      )}
      {sheet.more && (
        <s-banner tone="warning" heading={`Showing the first ${data.max.toLocaleString()} matching variants`}>
          One line sheet holds up to {data.max.toLocaleString()} variants. Narrow it with the
          vendor, product type or tag filters.
        </s-banner>
      )}

      <s-section heading="Choose products">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
            <s-select
              label="Vendor"
              value={filters.vendor}
              onChange={(e) => filter({ vendor: e.currentTarget.value })}
            >
              <s-option value={ALL}>All vendors</s-option>
              {vendors.map((v) => (
                <s-option key={v} value={v}>
                  {v}
                </s-option>
              ))}
            </s-select>
            <s-select
              label="Product type"
              value={filters.productType}
              onChange={(e) => filter({ productType: e.currentTarget.value })}
            >
              <s-option value={ALL}>All types</s-option>
              {types.map((t) => (
                <s-option key={t} value={t}>
                  {t}
                </s-option>
              ))}
            </s-select>
            <s-select
              label="Tag"
              value={filters.tag}
              onChange={(e) => filter({ tag: e.currentTarget.value })}
            >
              <s-option value={ALL}>All tags</s-option>
              {tags.map((t) => (
                <s-option key={t} value={t}>
                  {t}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-stack direction="inline" gap="base">
            <s-checkbox
              label="Include drafts"
              checked={filters.includeDrafts}
              onChange={(e) => filter({ includeDrafts: e.currentTarget.checked })}
            />
            <s-checkbox
              label="Hide out-of-stock variants"
              checked={filters.hideOutOfStock}
              onChange={(e) => filter({ hideOutOfStock: e.currentTarget.checked })}
            />
          </s-stack>

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>
              {selected.length} of {products.length} products selected
            </s-text>
            <s-button variant="tertiary" onClick={() => setExcluded(new Set())}>
              Select all
            </s-button>
            <s-button
              variant="tertiary"
              onClick={() =>
                setExcluded(new Set(products.map((p) => p.productId)))
              }
            >
              Select none
            </s-button>
          </s-stack>

          {missingCost > 0 && (
            <s-banner tone="warning">
              {missingCost} variants have no cost, so they show no wholesale
              price with cost-based pricing. Fix them from the Catalog audit
              page or switch to percent of retail.
            </s-banner>
          )}

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="kicker">Include</s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Vendor</s-table-header>
              <s-table-header listSlot="inline">Variants</s-table-header>
              <s-table-header format="currency">Wholesale</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.slice(0, 300).map((p) => {
                const prices = p.variants
                  .map((v) => v.wholesale)
                  .filter((n): n is number => n !== null);
                const low = Math.min(...prices);
                const high = Math.max(...prices);
                return (
                  <s-table-row key={p.productId}>
                    <s-table-cell>
                      <s-checkbox
                        label={`Include ${p.title}`}

                        checked={!excluded.has(p.productId)}
                        onChange={() => toggle(p.productId)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-thumbnail
                          src={p.imageUrl ?? undefined}
                          alt=""
                          size="small"
                        />
                        <s-text>{p.title}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{p.vendor}</s-table-cell>
                    <s-table-cell>{p.variants.length}</s-table-cell>
                    <s-table-cell>
                      {prices.length === 0
                        ? "—"
                        : low === high
                          ? `$${low.toFixed(2)}`
                          : `$${low.toFixed(2)}–$${high.toFixed(2)}`}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
          {products.length > 300 && (
            <s-text color="subdued">
              Showing the first 300 products here; all {selected.length}{" "}
              selected products go on the line sheet. Narrow the filters to
              review them individually.
            </s-text>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Wholesale pricing">
        <s-stack direction="block" gap="base">
          <s-select
            label="Price wholesale as"
            value={settings.pricingMode}
            onChange={(e) =>
              update("pricingMode", e.currentTarget.value as PricingMode)
            }
          >
            <s-option value="percent_of_retail">Percent of retail price</s-option>
            <s-option value="cost_markup">Cost × markup</s-option>
          </s-select>
          {settings.pricingMode === "percent_of_retail" ? (
            <s-number-field
              label="Percent of retail (%)"
              value={String(settings.percentOfRetail)}
              min={1}
              max={100}
              onChange={(e) =>
                update("percentOfRetail", Number(e.currentTarget.value) || 0)
              }
            />
          ) : (
            <s-number-field
              label="Markup on cost (×)"
              value={String(settings.costMarkup)}
              min={1}
              step={0.1}
              onChange={(e) =>
                update("costMarkup", Number(e.currentTarget.value) || 0)
              }
            />
          )}
          <s-checkbox
            label="Show MSRP"
            checked={settings.showMsrp}
            onChange={(e) => update("showMsrp", e.currentTarget.checked)}
          />
          <s-checkbox
            label="Show stock on hand"
            checked={settings.showStock}
            onChange={(e) => update("showStock", e.currentTarget.checked)}
          />
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Header">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Company name"
            value={settings.company}
            onInput={(e) => update("company", e.currentTarget.value)}
          />
          <s-text-field
            label="Title"
            value={settings.title}
            onInput={(e) => update("title", e.currentTarget.value)}
          />
          <s-text-area
            label="Contact info"
            rows={3}
            value={settings.contact}
            onInput={(e) => update("contact", e.currentTarget.value)}
          />
          <s-text-area
            label="Terms (minimums, ship dates, payment)"
            rows={3}
            value={settings.terms}
            onInput={(e) => update("terms", e.currentTarget.value)}
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
