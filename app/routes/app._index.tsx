import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { catalogForPage, latestCatalog, planCap } from "../lib/catalog.server";
import { auditScan, type AuditFilters } from "../lib/audit.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { PLANS, VARIANT_LIMIT } from "../lib/plans";
import { ScanBanner, ScanProgress, useCatalogScan } from "../components/CatalogScan";
import { Updating, dimmed, usePendingQuery } from "../components/Updating";
import {
  ISSUE_INFO,
  downloadFile,
  numericId,
  toCsv,
  variantLabel,
  type IssueCode,
} from "../lib/catalog";

const PAGE_SIZE = 100;
const EXPORT_LIMIT = 25_000;
const ISSUE_CODES = Object.keys(ISSUE_INFO) as IssueCode[];

/** The audit's settings and filters live in the address. */
function filtersFrom(request: Request): AuditFilters {
  const url = new URL(request.url);
  const issue = url.searchParams.get("issue");
  const margin = Number(url.searchParams.get("margin"));
  return {
    minMargin: Number.isFinite(margin) && url.searchParams.has("margin") ? margin : 30,
    includeDrafts: url.searchParams.get("drafts") === "1",
    issue: issue && issue in ISSUE_INFO ? (issue as IssueCode) : "all",
    q: url.searchParams.get("q") ?? "",
    limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || PAGE_SIZE, PAGE_SIZE), 5000),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [catalog, plan] = await Promise.all([
    catalogForPage(session.shop, admin),
    getPlan(session.shop, admin),
  ]);
  const filters = filtersFrom(request);
  const base = { ...catalog, plan, filters, upgradeUrl: planSelectionUrl(session.shop) };
  if (!catalog.scanId || catalog.count === null) return { ...base, audit: null, cap: null };

  const cap = await planCap(catalog.scanId, catalog.count, VARIANT_LIMIT[plan]);
  const audit = await auditScan(catalog.scanId, filters, { maxId: cap.maxId, take: filters.limit });
  return { ...base, audit, cap: { limit: cap.limit, over: cap.over } };
};

// Every issue matching the filters, for the CSV download.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const catalog = await latestCatalog(session.shop);
  if (!catalog) return { rows: [] };
  const plan = await getPlan(session.shop, admin);
  const cap = await planCap(catalog.scanId, catalog.count, VARIANT_LIMIT[plan]);
  const filters = filtersFrom(request);
  const { rows } = await auditScan(catalog.scanId, filters, { maxId: cap.maxId, take: EXPORT_LIMIT });
  return {
    rows: rows.flatMap((r) =>
      r.issues
        .filter((i) => filters.issue === "all" || i.code === filters.issue)
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
    ),
  };
};

const WEIGHT_UNIT: Record<string, string> = { POUNDS: "lb", OUNCES: "oz", GRAMS: "g", KILOGRAMS: "kg" };

export default function AuditPage() {
  const data = useLoaderData<typeof loader>();
  const { scan, running, rescan } = useCatalogScan(data.scan, data.scannedAt);
  const navigate = useNavigate();
  const exporter = useFetcher<typeof action>();
  const { filters, audit, cap } = data;
  const [search, setSearch] = useState(filters.q);
  const [margin, setMargin] = useState(String(filters.minMargin));
  // While new results load, show the chosen filter at once and say so.
  const pending = usePendingQuery("/app");
  const shownIssue = pending ? (pending.get("issue") ?? "all") : filters.issue;

  const go = (change: Partial<AuditFilters>) => {
    const next = { ...filters, limit: PAGE_SIZE, ...change };
    const qs = new URLSearchParams();
    if (next.minMargin !== 30) qs.set("margin", String(next.minMargin));
    if (next.includeDrafts) qs.set("drafts", "1");
    if (next.issue !== "all") qs.set("issue", next.issue);
    if (next.q) qs.set("q", next.q);
    if (next.limit !== PAGE_SIZE) qs.set("limit", String(next.limit));
    navigate(`/app${qs.size ? `?${qs}` : ""}`, { preventScrollReset: true });
  };

  useEffect(() => {
    const rows = exporter.data?.rows;
    if (!rows?.length) return;
    downloadFile(
      `catalog-audit-${(data.scannedAt ?? "").slice(0, 10)}.csv`,
      toCsv(
        ["Severity", "Issue", "Detail", "Product", "Variant", "SKU", "Barcode", "Vendor", "Status", "Price", "Cost", "Weight", "Weight unit", "Product ID", "Variant ID"],
        rows,
      ),
      "text/csv;charset=utf-8",
    );
  }, [exporter.data, data.scannedAt]);

  if (!audit || !cap) {
    return (
      <s-page heading="Catalog audit">
        <ScanProgress scan={scan} onRetry={rescan} />
      </s-page>
    );
  }

  const nextPlan = data.plan === "free" ? "pro" : data.plan === "pro" ? "warehouse" : null;
  const shownCount = filters.issue === "all" && !filters.q ? audit.withIssues : audit.matching;

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
      <s-button
        slot="secondary-actions"
        onClick={() =>
          exporter.submit({}, { method: "POST", action: `/app${window.location.search}` })
        }
        {...(exporter.state !== "idle" ? { loading: true } : {})}
      >
        Export issues (CSV)
      </s-button>

      <ScanBanner scan={scan} scannedAt={data.scannedAt} onRetry={rescan} />
      {cap.over && (
        <s-banner tone="info" heading={`Auditing your first ${cap.limit.toLocaleString()} variants`}>
          <s-stack direction="block" gap="small">
            <s-text>
              The {PLANS[data.plan].name} plan covers up to {cap.limit.toLocaleString()} active and
              draft variants. Your catalog has {(data.count ?? 0).toLocaleString()}.
              {nextPlan
                ? ` ${PLANS[nextPlan].name} covers up to ${VARIANT_LIMIT[nextPlan].toLocaleString()}; every paid plan starts with a 14-day free trial.`
                : " Contact us for larger catalogs."}
            </s-text>
            {nextPlan && (
              <s-button href={data.upgradeUrl} target="_top">
                See plans
              </s-button>
            )}
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Summary">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>
              Scanned {audit.scanned.toLocaleString()} variants ·{" "}
              {audit.withIssues.toLocaleString()} have issues ·{" "}
              {audit.critical.toLocaleString()} critical · last scan{" "}
              {new Date(data.scannedAt ?? "").toLocaleString()}
            </s-text>
            {pending && <Updating />}
          </s-stack>
          <s-stack direction="inline" gap="small-200">
            <s-clickable-chip
              color={shownIssue === "all" ? "strong" : "base"}
              onClick={() => go({ issue: "all" })}
            >
              All issues ({audit.withIssues.toLocaleString()})
            </s-clickable-chip>
            {ISSUE_CODES.filter((k) => audit.counts[k] > 0).map((k) => (
              <s-clickable-chip
                key={k}
                color={shownIssue === k ? "strong" : "base"}
                onClick={() => go({ issue: k })}
              >
                {ISSUE_INFO[k].label} ({audit.counts[k].toLocaleString()})
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
            placeholder="Search by product, SKU or vendor, then press Enter"
            value={search}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onChange={(e) => go({ q: e.currentTarget.value.trim() })}
          />
          {pending && <Updating />}
          <div style={dimmed(!!pending)} aria-busy={!!pending}>
            {audit.rows.length === 0 ? (
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
                  {audit.rows.map((r) => (
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
                      <s-table-cell>{r.cost === null ? "—" : `$${r.cost.toFixed(2)}`}</s-table-cell>
                      <s-table-cell>
                        {r.weight ? `${r.weight} ${WEIGHT_UNIT[r.weightUnit ?? ""] ?? r.weightUnit?.toLowerCase() ?? ""}` : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-300">
                          {r.issues.map((i) => (
                            // Detail under the badge, so long details wrap in the column.
                            <s-stack key={i.code} direction="block" gap="small-500">
                              <s-badge tone={ISSUE_INFO[i.code].severity}>
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
          </div>
          {shownCount > audit.rows.length && (
            <s-button
              onClick={() => go({ limit: filters.limit + PAGE_SIZE })}
              {...(pending ? { loading: true } : {})}
            >
              Show more ({(shownCount - audit.rows.length).toLocaleString()} left)
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Settings">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Minimum margin target (%)"
            value={margin}
            min={0}
            max={100}
            onInput={(e) => setMargin(e.currentTarget.value)}
            onChange={(e) => go({ minMargin: Number(e.currentTarget.value) || 0 })}
          />
          <s-checkbox
            label="Include draft products"
            checked={filters.includeDrafts}
            onChange={(e) => go({ includeDrafts: e.currentTarget.checked })}
          />
          <s-text color="subdued">Archived products are never audited.</s-text>
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
