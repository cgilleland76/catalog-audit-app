import { useMemo, useState, type ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { catalogForPage } from "../lib/catalog.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { FREE_VARIANT_LIMIT } from "../lib/plans";
import { ScanBanner, ScanProgress, useCatalogScan } from "../components/CatalogScan";
import {
  ISSUE_INFO,
  auditCatalog,
  downloadFile,
  numericId,
  toCsv,
  variantLabel,
  type CatalogRow,
  type IssueCode,
} from "../lib/catalog";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [catalog, plan] = await Promise.all([
    catalogForPage(session.shop, admin),
    getPlan(session.shop, admin),
  ]);
  return { ...catalog, plan, upgradeUrl: planSelectionUrl(session.shop) };
};

const PAGE_SIZE = 100;
const ISSUE_CODES = Object.keys(ISSUE_INFO) as IssueCode[];

export default function AuditPage() {
  const { rows, scannedAt, scan: initialScan, plan, upgradeUrl } =
    useLoaderData<typeof loader>();
  const { scan, running, rescan } = useCatalogScan(initialScan, scannedAt);

  if (!rows) {
    return (
      <s-page heading="Catalog audit">
        <ScanProgress scan={scan} onRetry={rescan} />
      </s-page>
    );
  }
  // The Free plan audits the first FREE_VARIANT_LIMIT variants.
  const limited = plan === "free" && rows.length > FREE_VARIANT_LIMIT;
  return (
    <AuditResults
      rows={limited ? rows.slice(0, FREE_VARIANT_LIMIT) : rows}
      scannedAt={scannedAt ?? ""}
      banner={
        <>
          <ScanBanner scan={scan} scannedAt={scannedAt} onRetry={rescan} />
          {limited && (
            <s-banner tone="info" heading="Showing your first 500 variants">
              <s-stack direction="block" gap="small">
                <s-text>
                  The Free plan audits up to {FREE_VARIANT_LIMIT} variants. Your
                  catalog has {rows.length.toLocaleString()}. Upgrade to Pro to
                  audit all of them; it starts with a 14-day free trial.
                </s-text>
                <s-button href={upgradeUrl} target="_top">
                  See plans
                </s-button>
              </s-stack>
            </s-banner>
          )}
        </>
      }
      running={running}
      rescan={rescan}
    />
  );
}

function AuditResults({
  rows,
  scannedAt,
  banner,
  running,
  rescan,
}: {
  rows: CatalogRow[];
  scannedAt: string;
  banner: ReactNode;
  running: boolean;
  rescan: () => void;
}) {
  const [minMargin, setMinMargin] = useState(30);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [filter, setFilter] = useState<IssueCode | "all">("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const audited = useMemo(
    () =>
      auditCatalog(rows, {
        minMarginPercent: minMargin,
        includeDrafts,
        includeArchived: false,
      }),
    [rows, minMargin, includeDrafts],
  );

  const counts = useMemo(() => {
    const c = Object.fromEntries(ISSUE_CODES.map((k) => [k, 0])) as Record<
      IssueCode,
      number
    >;
    for (const r of audited) for (const i of r.issues) c[i.code]++;
    return c;
  }, [audited]);

  const withIssues = useMemo(
    () => audited.filter((r) => r.issues.length > 0),
    [audited],
  );
  const criticalCount = withIssues.filter((r) =>
    r.issues.some((i) => ISSUE_INFO[i.code].severity === "critical"),
  ).length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return withIssues.filter(
      (r) =>
        (filter === "all" || r.issues.some((i) => i.code === filter)) &&
        (!q ||
          variantLabel(r).toLowerCase().includes(q) ||
          (r.sku ?? "").toLowerCase().includes(q) ||
          r.vendor.toLowerCase().includes(q)),
    );
  }, [withIssues, filter, search]);

  const exportCsv = () => {
    const lines = visible.flatMap((r) =>
      r.issues
        .filter((i) => filter === "all" || i.code === filter)
        .map((i) => [
          ISSUE_INFO[i.code].severity,
          ISSUE_INFO[i.code].label,
          i.detail,
          r.productTitle,
          r.variantTitle,
          r.sku,
          r.barcode,
          r.vendor,
          r.status,
          r.price,
          r.cost,
          r.weight,
          r.weightUnit,
          numericId(r.productId),
          numericId(r.variantId),
        ]),
    );
    const csv = toCsv(
      [
        "Severity",
        "Issue",
        "Detail",
        "Product",
        "Variant",
        "SKU",
        "Barcode",
        "Vendor",
        "Status",
        "Price",
        "Cost",
        "Weight",
        "Weight unit",
        "Product ID",
        "Variant ID",
      ],
      lines,
    );
    downloadFile(
      `catalog-audit-${scannedAt.slice(0, 10)}.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
  };

  const toneFor = (code: IssueCode) => ISSUE_INFO[code].severity;

  return (
    <s-page heading="Catalog audit">
      <s-button
        slot="primary-action"
        onClick={rescan}
        disabled={running}
        {...(running ? { loading: true } : {})}
      >
        Rescan catalog
      </s-button>
      <s-button slot="secondary-actions" onClick={exportCsv}>
        Export issues (CSV)
      </s-button>

      {banner}

      <s-section heading="Summary">
        <s-stack direction="block" gap="base">
          <s-text>
            Scanned {audited.length.toLocaleString()} variants ·{" "}
            {withIssues.length.toLocaleString()} have issues ·{" "}
            {criticalCount.toLocaleString()} critical · last scan{" "}
            {new Date(scannedAt).toLocaleString()}
          </s-text>
          <s-stack direction="inline" gap="small-200">
            <s-clickable-chip
              color={filter === "all" ? "strong" : "base"}
              onClick={() => {
                setFilter("all");
                setLimit(PAGE_SIZE);
              }}
            >
              All issues ({withIssues.length})
            </s-clickable-chip>
            {ISSUE_CODES.filter((k) => counts[k] > 0).map((k) => (
              <s-clickable-chip
                key={k}
                color={filter === k ? "strong" : "base"}
                onClick={() => {
                  setFilter(k);
                  setLimit(PAGE_SIZE);
                }}
              >
                {ISSUE_INFO[k].label} ({counts[k]})
              </s-clickable-chip>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Issues">
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by product, SKU or vendor"
            value={search}
            onInput={(e) => {
              setSearch(e.currentTarget.value);
              setLimit(PAGE_SIZE);
            }}
          />
          {visible.length === 0 ? (
            <s-paragraph>No issues match. Nice work.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">SKU</s-table-header>
                <s-table-header format="currency">Price</s-table-header>
                <s-table-header format="currency">Cost</s-table-header>
                <s-table-header>Weight</s-table-header>
                <s-table-header listSlot="inline">Issues</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visible.slice(0, limit).map((r) => (
                  <s-table-row key={r.variantId}>
                    <s-table-cell>
                      <s-link
                        href={`shopify://admin/products/${numericId(r.productId)}/variants/${numericId(r.variantId)}`}
                        target="_blank"
                      >
                        {variantLabel(r)}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{r.sku ?? "—"}</s-table-cell>
                    <s-table-cell>${r.price.toFixed(2)}</s-table-cell>
                    <s-table-cell>
                      {r.cost === null ? "—" : `$${r.cost.toFixed(2)}`}
                    </s-table-cell>
                    <s-table-cell>
                      {r.weight ? `${r.weight} ${r.weightUnit?.toLowerCase()}` : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-300">
                        {r.issues.map((i) => (
                          <s-stack key={i.code} direction="inline" gap="small-300">
                            <s-badge tone={toneFor(i.code)}>
                              {ISSUE_INFO[i.code].label}
                            </s-badge>
                            <s-text color="subdued">{i.detail}</s-text>
                          </s-stack>
                        ))}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          {visible.length > limit && (
            <s-button onClick={() => setLimit(limit + PAGE_SIZE)}>
              Show more ({(visible.length - limit).toLocaleString()} left)
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Settings">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Minimum margin target (%)"
            value={String(minMargin)}
            min={0}
            max={100}
            onChange={(e) =>
              setMinMargin(Number(e.currentTarget.value) || 0)
            }
          />
          <s-checkbox
            label="Include draft products"
            checked={includeDrafts}
            onChange={(e) =>
              setIncludeDrafts(e.currentTarget.checked)
            }
          />
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="What gets checked">
        <s-unordered-list>
          <s-list-item>Critical: price below cost, $0 price, duplicate SKU, missing weight on shippable items</s-list-item>
          <s-list-item>Warning: missing SKU or cost, low margin, duplicate barcode, compare-at price not above price</s-list-item>
          <s-list-item>Info: missing barcode or product image</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
