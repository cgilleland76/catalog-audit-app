import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { catalogForPage, type Scope } from "../lib/catalog.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { canUseWarehouse, VARIANT_LIMIT } from "../lib/plans";
import {
  activeFix,
  advanceFix,
  batchRows,
  canWriteProducts,
  createFixBatch,
  problemItems,
  recentFixes,
  startUndo,
} from "../lib/fixes.server";
import {
  FIELD_LABEL,
  FIX_FIELDS,
  fixableField,
  FREQUENCIES,
  UNDO_DAYS,
  type FixField,
  type Frequency,
} from "../lib/fixes";
import { parseFields, saveSyncSetting } from "../lib/sync.server";
import { UpgradeSection } from "../components/Upgrade";
import { ScanBanner, useCatalogScan } from "../components/CatalogScan";
import { fixStatus, fixSummary, hideModal } from "../components/fixes";
import { count, downloadFile, numericId, toCsv } from "../lib/catalog";
import {
  PROVIDERS,
  isListed,
  deleteCredentials,
  getProvider,
  loadCredentials,
  providerInfo,
  saveCredentials,
  advanceComparison,
  createComparison,
  mismatchCounts,
  mismatchPage,
} from "../lib/wms/index.server";
import {
  MISMATCH_INFO,
  type Mismatch,
  type MismatchCode,
  type WmsProviderInfo,
} from "../lib/wms/types";

// ?provider=<id> opens that system's comparison; without it, the page lists
// every supported system so merchants can connect one or more.
const providerParam = (request: Request) =>
  new URL(request.url).searchParams.get("provider");

const summarize = (c: {
  status: string;
  stage: string;
  scope: string;
  checked: number;
  total: number;
  mismatchCount: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}) => ({
  status: c.status,
  stage: c.stage,
  scope: c.scope as Scope,
  checked: c.checked,
  total: c.total,
  error: c.error,
  startedAt: c.startedAt.toISOString(),
  finishedAt: c.finishedAt?.toISOString() ?? null,
  differences: c.mismatchCount,
});

const PAGE_SIZE = 100;
const FIX_PREVIEW_ROWS = 25;
const EXPORT_LIMIT = 25_000;

/** The issue filter and how many rows to show, from the address. */
function resultParams(request: Request) {
  const url = new URL(request.url);
  const issue = url.searchParams.get("issue");
  return {
    issue: (issue && issue in MISMATCH_INFO ? issue : "all") as
      | MismatchCode
      | "all",
    limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || PAGE_SIZE, PAGE_SIZE), 5000),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!canUseWarehouse(await getPlan(session.shop, admin))) {
    return { locked: true as const, upgradeUrl: planSelectionUrl(session.shop) };
  }

  const param = providerParam(request);
  const credentials = param ? await loadCredentials(session.shop, param) : null;

  // The list of systems (also shown when the chosen system isn't connected).
  if (!param || !PROVIDERS[param] || !credentials) {
    const [connections, latest] = await Promise.all([
      prisma.wmsConnection.findMany({
        where: { shop: session.shop },
        select: { provider: true, updatedAt: true },
      }),
      prisma.wmsComparison.findMany({
        where: { shop: session.shop },
        orderBy: { startedAt: "desc" },
        distinct: ["provider"],
      }),
    ]);
    return {
      locked: false as const,
      view: "list" as const,
      systems: Object.values(PROVIDERS)
        .map((p) => {
          const comparison = latest.find((c) => c.provider === p.id);
          return {
            ...providerInfo(p),
            connected: connections.some((c) => c.provider === p.id),
            comparison: comparison ? summarize(comparison) : null,
          };
        })
        .filter((s) => isListed(s.id, s.connected)),
    };
  }

  const provider = getProvider(param);
  const catalog = await catalogForPage(session.shop, admin);
  const filters = resultParams(request);
  const [latest, fixes, active, sync] = await Promise.all([
    prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id },
      orderBy: { startedAt: "desc" },
    }),
    recentFixes(session.shop, provider.id),
    activeFix(session.shop),
    prisma.syncSetting.findUnique({
      where: { shop_provider: { shop: session.shop, provider: provider.id } },
    }),
  ]);
  const withProblems = fixes.find((b) => b.failed > 0 || b.kept > 0);
  const problems = withProblems ? await problemItems(withProblems.id) : [];

  return {
    locked: false as const,
    view: "compare" as const,
    provider: providerInfo(provider),
    catalogCount: catalog.count,
    scannedAt: catalog.scannedAt,
    scan: catalog.scan,
    canWrite: await canWriteProducts(admin),
    activeFix: active && { id: active.id, status: active.status, provider: active.provider },
    fixes: await batchRows(fixes),
    problems: problems.map((i) => ({
      id: i.id,
      sku: i.sku,
      label: i.label,
      field: i.field as FixField,
      status: i.status,
      error: i.error,
    })),
    sync: {
      enabled: sync?.enabled ?? false,
      frequency: sync?.frequency ?? "daily",
      fixFields: parseFields(sync?.fixFields),
      scope: (sync?.scope ?? "active") as Scope,
      stage: sync?.stage ?? "idle",
      lastRunAt: sync?.lastRunAt?.toISOString() ?? null,
      lastStatus: sync?.lastStatus ?? null,
      lastMessage: sync?.lastMessage ?? null,
      nextRunAt: sync?.nextRunAt?.toISOString() ?? null,
    },
    filters,
    counts: latest?.status === "done" ? await mismatchCounts(latest.id) : null,
    results:
      latest?.status === "done"
        ? await mismatchPage(latest.id, {
            code: filters.issue === "all" ? null : filters.issue,
            take: filters.limit,
          })
        : [],
    fixPreview:
      latest?.status === "done"
        ? await mismatchPage(latest.id, { fixableOnly: true, take: FIX_PREVIEW_ROWS * 3 })
        : [],
    comparison: latest && { id: latest.id, ...summarize(latest) },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!canUseWarehouse(await getPlan(session.shop, admin))) {
    return { ok: false, message: "Warehouse comparison is part of the Warehouse plan" };
  }
  const form = await request.formData();
  const intent = form.get("intent");
  const provider = getProvider(
    String(form.get("provider") ?? providerParam(request) ?? ""),
  );

  if (intent === "connect") {
    if (!isListed(provider.id, !!(await loadCredentials(session.shop, provider.id)))) {
      return { ok: false, message: `${provider.name} isn't available yet` };
    }
    const credentials: Record<string, string> = {};
    for (const field of provider.credentialFields) {
      const value = String(form.get(field.key) ?? "").trim();
      if (value) credentials[field.key] = value;
    }
    try {
      await provider.testConnection(credentials);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await saveCredentials(session.shop, provider.id, credentials);
    return { ok: true, message: `Connected to ${provider.name}` };
  }

  if (intent === "disconnect") {
    await deleteCredentials(session.shop, provider.id);
    // Its scheduled sync can't run without the connection.
    await prisma.syncSetting.updateMany({
      where: { shop: session.shop, provider: provider.id },
      data: { enabled: false },
    });
    return { ok: true, message: `Disconnected ${provider.name}; its scheduled sync is off` };
  }

  if (intent === "compare") {
    const credentials = await loadCredentials(session.shop, provider.id);
    if (!credentials) return { ok: false, message: "Connect first" };

    const running = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "running" },
    });
    if (running) return { ok: false, message: "A comparison is already running" };

    const scope: Scope = form.get("scope") === "active_draft" ? "active_draft" : "active";
    const plan = await getPlan(session.shop, admin);
    const comparison = await createComparison(session.shop, provider, scope, VARIANT_LIMIT[plan]);
    if (!comparison) {
      return { ok: false, message: "Your catalog is still being read; try again in a minute" };
    }
    return {
      ok: true,
      message: `Checking ${comparison.total.toLocaleString()} SKUs in ${provider.name}`,
    };
  }

  if (intent === "fix") {
    const fields = FIX_FIELDS.filter((f) =>
      String(form.get("fields") ?? "").split(",").includes(f),
    );
    const comparison = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "done" },
      orderBy: { startedAt: "desc" },
    });
    if (!comparison) return { ok: false, message: "Run a comparison first" };
    const created = await createFixBatch({
      shop: session.shop,
      provider: provider.id,
      comparisonId: comparison.id,
      fields,
      source: "manual",
    });
    if (!created.batch) return { ok: false, message: created.error ?? "Nothing to fix" };
    return { ok: true, message: `Fixing ${created.batch.total.toLocaleString()} values in Shopify` };
  }

  if (intent === "undo") {
    const result = await startUndo(session.shop, { batchId: String(form.get("batchId") ?? "") });
    if (result.error) return { ok: false, message: result.error };
    return { ok: true, message: "Undoing the fix" };
  }

  if (intent === "saveSync") {
    await saveSyncSetting(session.shop, provider.id, {
      enabled: form.get("enabled") === "true",
      frequency: String(form.get("frequency") ?? "daily"),
      fixFields: FIX_FIELDS.filter((f) =>
        String(form.get("fixFields") ?? "").split(",").includes(f),
      ),
      scope: String(form.get("scope") ?? "active"),
    });
    return {
      ok: true,
      message: form.get("enabled") === "true" ? "Scheduled sync saved" : "Scheduled sync turned off",
    };
  }

  // Runs the next few seconds of a comparison or fix; the page calls this
  // while it polls. (Scheduled syncs advance on their own.)
  // Every difference of the current filter, for the CSV download.
  if (intent === "export") {
    const latest = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "done" },
      orderBy: { startedAt: "desc" },
    });
    if (!latest) return { ok: false, message: "Run a comparison first" };
    const { issue } = resultParams(request);
    const rows = await mismatchPage(latest.id, {
      code: issue === "all" ? null : issue,
      take: EXPORT_LIMIT,
    });
    return { ok: true, message: "", rows };
  }

  if (intent === "step") {
    const running = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "running" },
    });
    if (running) {
      await advanceComparison(running.id);
    }
    const fix = await activeFix(session.shop);
    if (fix) await advanceFix(fix.id, admin);
    return { ok: true, message: "" };
  }

  return { ok: false, message: "Unknown action" };
};

const CODES = Object.keys(MISMATCH_INFO) as MismatchCode[];

type Loaded = Extract<
  ReturnType<typeof useLoaderData<typeof loader>>,
  { locked: false }
>;

export default function WarehousePage() {
  const data = useLoaderData<typeof loader>();
  if (data.locked) {
    return (
      <s-page heading="Warehouse comparison">
        <UpgradeSection
          feature="Warehouse comparison"
          needs="warehouse"
          upgradeUrl={data.upgradeUrl}
        />
      </s-page>
    );
  }
  return data.view === "list" ? (
    <WarehouseSystems {...data} />
  ) : (
    <WarehouseComparison {...data} />
  );
}

const modalId = (providerId: string) => `connect-${providerId}`;

function comparisonSummary(
  c: NonNullable<Extract<Loaded, { view: "list" }>["systems"][number]["comparison"]>,
) {
  if (c.status === "running") {
    return `Running — ${c.checked.toLocaleString()} of ${c.total.toLocaleString()} checked`;
  }
  if (c.status === "failed") return "Last comparison failed";
  return `${count(c.differences, "difference")} in ${count(c.total, "SKU")} · ${new Date(c.finishedAt ?? c.startedAt).toLocaleDateString()}`;
}

function WarehouseSystems({ systems }: Extract<Loaded, { view: "list" }>) {
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const connectedCount = systems.filter((s) => s.connected).length;

  useEffect(() => {
    if (fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Warehouse comparison">
      <s-section heading="Warehouse systems">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Connect the warehouse systems you use, one or several. SKU Doctor
            compares each one with your Shopify catalog on its own.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">System</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="secondary">Last comparison</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {systems.map((system) => {
                const disconnecting =
                  fetcher.state !== "idle" &&
                  fetcher.formData?.get("provider") === system.id;
                return (
                  <s-table-row key={system.id}>
                    <s-table-cell>
                      <s-text type="strong">{system.name}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {system.connected ? (
                        <s-badge tone="success">Connected</s-badge>
                      ) : (
                        <s-badge>Not connected</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {system.connected && system.comparison
                        ? comparisonSummary(system.comparison)
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {system.connected ? (
                        <s-stack direction="inline" gap="small-200">
                          <s-button
                            variant="primary"
                            onClick={() => navigate(`/app/warehouse?provider=${system.id}`)}
                          >
                            Open comparison
                          </s-button>
                          <s-button commandFor={modalId(system.id)} command="--show">
                            Update token
                          </s-button>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            onClick={() =>
                              fetcher.submit(
                                { intent: "disconnect", provider: system.id },
                                { method: "POST" },
                              )
                            }
                            {...(disconnecting ? { loading: true } : {})}
                          >
                            Disconnect
                          </s-button>
                        </s-stack>
                      ) : (
                        <s-button
                          variant="primary"
                          commandFor={modalId(system.id)}
                          command="--show"
                        >
                          Connect
                        </s-button>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      {systems.map((system) => (
        <ConnectModal
          key={system.id}
          provider={system}
          reconnect={system.connected}
          onConnected={() =>
            // Straight to the comparison for a first connection.
            !system.connected && navigate(`/app/warehouse?provider=${system.id}`)
          }
        />
      ))}

      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>
            {connectedCount === 0
              ? "Choose Connect next to your warehouse system"
              : `${connectedCount} of ${systems.length} systems connected`}
          </s-list-item>
          <s-list-item>Tokens are tested before they&apos;re saved, and stored encrypted</s-list-item>
          <s-list-item>Nothing changes in Shopify unless you choose Fix; your warehouse is never changed</s-list-item>
        </s-unordered-list>
      </s-section>
      <s-section slot="aside" heading="Need another system?">
        <s-paragraph>
          Tell us which warehouse system you use on the{" "}
          <s-link href="/app/support">Support</s-link> page.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

/** Popout with a system's credential fields; tests them before saving. */
function ConnectModal({
  provider,
  reconnect,
  onConnected,
}: {
  provider: WmsProviderInfo;
  reconnect: boolean;
  onConnected: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) {
      const modal = document.getElementById(modalId(provider.id)) as
        | (HTMLElement & { hideOverlay?: () => void })
        | null;
      modal?.hideOverlay?.();
      onConnected();
    }
    // onConnected changes every render; react only to new results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, shopify]);

  return (
    <s-modal
      id={modalId(provider.id)}
      heading={`${reconnect ? "Update" : "Connect"} ${provider.name}`}
    >
      <s-stack direction="block" gap="base">
        <s-paragraph>{provider.setupHelp}</s-paragraph>
        {fetcher.data && !fetcher.data.ok && (
          <s-banner tone="critical">{fetcher.data.message}</s-banner>
        )}
        {provider.credentialFields.map((field) => {
          const props = {
            label: field.label + (field.optional ? " (optional)" : ""),
            details: field.helpText,
            value: credentials[field.key] ?? "",
            onInput: (e: Event) => {
              const value = (e.currentTarget as HTMLInputElement).value;
              setCredentials((c) => ({ ...c, [field.key]: value }));
            },
          };
          return field.secret ? (
            <s-password-field key={field.key} {...props} />
          ) : (
            <s-text-field key={field.key} {...props} />
          );
        })}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() =>
          fetcher.submit(
            { ...credentials, intent: "connect", provider: provider.id },
            { method: "POST" },
          )
        }
        {...(busy ? { loading: true } : {})}
      >
        Test and connect
      </s-button>
      <s-button slot="secondary-actions" commandFor={modalId(provider.id)} command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}

function WarehouseComparison({
  provider,
  comparison,
  catalogCount,
  scannedAt,
  scan: initialScan,
  canWrite,
  activeFix,
  fixes,
  problems,
  sync,
  filters,
  counts,
  results,
  fixPreview,
}: Extract<Loaded, { view: "compare" }>) {
  const catalogScan = useCatalogScan(initialScan, scannedAt);
  const catalogReady = catalogCount !== null;
  const fetcher = useFetcher<typeof action>();
  const stepper = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const exporter = useFetcher<typeof action>();
  const [scope, setScope] = useState<Scope>(comparison?.scope ?? "active");
  const filter = filters.issue;
  // Filters live in the address, so the server sends only the rows shown.
  const show = (issue: MismatchCode | "all", limit = PAGE_SIZE) =>
    navigate(`/app/warehouse?provider=${provider.id}&issue=${issue}&limit=${limit}`, {
      preventScrollReset: true,
    });

  const busy = fetcher.state !== "idle";
  const running = comparison?.status === "running";
  // Comparisons and fixes advance only while something asks for the next step.
  const stepping = running || activeFix !== null;
  const [undoId, setUndoId] = useState<string | null>(null);
  const codes = CODES.filter((k) => k !== "cost_mismatch" || provider.comparesCost);

  useEffect(() => {
    if (!fetcher.data) return;
    // After a disconnect the loader returns the list of systems by itself.
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  // While a comparison runs, keep asking the server to do the next step.
  // Each finished step re-runs the loader, which shows the new progress.
  useEffect(() => {
    if (!stepping) return;
    const tick = () => {
      if (stepper.state === "idle") {
        stepper.submit({ intent: "step", provider: provider.id }, { method: "POST" });
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [stepping, stepper, provider.id]);

  const total = (k: MismatchCode) => counts?.[k].total ?? 0;
  const differences = comparison?.differences ?? 0;
  const shown = filter === "all" ? differences : total(filter);
  const fixable = counts
    ? FIX_FIELDS.reduce((n, f) => n + counts[`${f}_mismatch` as MismatchCode].fixable, 0)
    : 0;

  const submit = (data: Record<string, string>) =>
    fetcher.submit({ ...data, provider: provider.id }, { method: "POST" });

  const exportCsv = () =>
    exporter.submit(
      { intent: "export", provider: provider.id },
      { method: "POST", action: `/app/warehouse?provider=${provider.id}&issue=${filter}` },
    );
  useEffect(() => {
    const rows = exporter.data && "rows" in exporter.data ? exporter.data.rows : null;
    if (!rows) return;
    downloadFile(
      `${provider.id}-comparison-${(comparison?.startedAt ?? "").slice(0, 10)}.csv`,
      toCsv(
        ["Issue", "SKU", "Product", "Shopify", provider.name, "Product ID", "Variant ID"],
        rows.map((m) => [
          MISMATCH_INFO[m.code].label,
          m.sku,
          m.label,
          m.shopify,
          m.wms,
          numericId(m.productId),
          numericId(m.variantId),
        ]),
      ),
      "text/csv;charset=utf-8",
    );
    // Only a new export should download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporter.data]);

  return (
    <s-page heading={`${provider.name} comparison`}>
      <s-link slot="breadcrumb-actions" onClick={() => navigate("/app/warehouse")}>
        Warehouse systems
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={running || busy || !catalogReady}
        onClick={() => submit({ intent: "compare", scope })}
        {...(busy && fetcher.formData?.get("intent") === "compare"
          ? { loading: true }
          : {})}
      >
        Run comparison
      </s-button>
      <s-button slot="secondary-actions" onClick={() => navigate("/app/warehouse")}>
        All warehouse systems
      </s-button>
      {comparison?.status === "done" && shown > 0 && (
        <s-button
          slot="secondary-actions"
          onClick={exportCsv}
          {...(exporter.state !== "idle" ? { loading: true } : {})}
        >
          Export (CSV)
        </s-button>
      )}

      {catalogReady ? (
        <ScanBanner
          scan={catalogScan.scan}
          scannedAt={scannedAt}
          onRetry={catalogScan.rescan}
        />
      ) : catalogScan.scan?.status === "failed" ? (
        <ScanBanner scan={catalogScan.scan} scannedAt={null} onRetry={catalogScan.rescan} />
      ) : (
        <s-banner tone="info">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Reading your catalog" size="base" />
            <s-text>
              Reading your Shopify catalog
              {catalogScan.scan && catalogScan.scan.objectCount > 0
                ? ` — ${catalogScan.scan.objectCount.toLocaleString()} variants so far`
                : ""}
              . You can run the comparison as soon as it finishes.
            </s-text>
          </s-stack>
        </s-banner>
      )}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-select
            label="Products to compare"
            value={scope}
            disabled={running}
            onChange={(e) => setScope(e.currentTarget.value as Scope)}
          >
            <s-option value="active">Active products</s-option>
            <s-option value="active_draft">Active and draft products</s-option>
          </s-select>
          <s-text color="subdued">
            {comparison
              ? `Last run: ${comparison.scope === "active_draft" ? "active and draft" : "active"} products. `
              : `Connected. Run a comparison to check your Shopify SKUs against ${provider.name}. `}
            Archived products are never compared.
          </s-text>
        </s-stack>
      </s-section>

      {running && comparison && (
        <s-section heading="Comparing…">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Comparing" />
            <s-text>
              {comparison.stage === "compare"
                ? `Comparing with what ${provider.name} returned; ${count(comparison.differences, "difference")} so far.`
                : comparison.checked === 0 && comparison.total > 0
                  ? `Reading products from ${provider.name} to check ${comparison.total.toLocaleString()} SKUs.`
                  : `Checked ${comparison.checked.toLocaleString()} of ${comparison.total.toLocaleString()} SKUs in ${provider.name}.`}{" "}
              Keep this page open; the comparison pauses while it&apos;s
              closed and picks up where it left off when you return.
            </s-text>
          </s-stack>
        </s-section>
      )}

      {comparison?.status === "failed" && (
        <s-banner tone="critical" heading="Comparison failed">
          <s-stack direction="block" gap="small">
            <s-text>{comparison.error}</s-text>
            <s-button commandFor={modalId(provider.id)} command="--show">
              Update connection
            </s-button>
          </s-stack>
        </s-banner>
      )}

      {comparison?.status === "done" && (
        <s-section heading="Results">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text color="subdued">
                {count(comparison.total, "SKU")} checked · {count(differences, "difference")} ·
                finished{" "}
                {new Date(comparison.finishedAt ?? comparison.startedAt).toLocaleString()}
              </s-text>
              {fixable > 0 && (
                <s-button
                  commandFor="fix-modal"
                  command="--show"
                  disabled={activeFix !== null}
                >
                  Fix in Shopify ({fixable.toLocaleString()})
                </s-button>
              )}
            </s-stack>
            <s-stack direction="inline" gap="small-200">
              {codes.map((k) => (
                <s-clickable-chip
                  key={k}
                  color={filter === k ? "strong" : "base"}
                  onClick={() => show(k)}
                >
                  {MISMATCH_INFO[k].label} ({total(k).toLocaleString()})
                </s-clickable-chip>
              ))}
              <s-clickable-chip
                color={filter === "all" ? "strong" : "base"}
                onClick={() => show("all")}
              >
                All ({differences.toLocaleString()})
              </s-clickable-chip>
            </s-stack>

            {results.length === 0 ? (
              <s-paragraph>Nothing here — Shopify and {provider.name} agree.</s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="secondary">SKU</s-table-header>
                  <s-table-header listSlot="inline">Issue</s-table-header>
                  <s-table-header>Shopify</s-table-header>
                  <s-table-header>{provider.name}</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {results.map((m) => (
                    <s-table-row key={`${m.variantId}-${m.code}`}>
                      <s-table-cell>
                        <s-link
                          href={`shopify://admin/products/${numericId(m.productId)}/variants/${numericId(m.variantId)}`}
                          target="_blank"
                        >
                          {m.label}
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>{m.sku}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={MISMATCH_INFO[m.code].tone}>
                          {MISMATCH_INFO[m.code].label}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{m.shopify}</s-table-cell>
                      <s-table-cell>{m.wms}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            {shown > results.length && (
              <s-button onClick={() => show(filter, filters.limit + PAGE_SIZE)}>
                Show more ({(shown - results.length).toLocaleString()} left)
              </s-button>
            )}
          </s-stack>
        </s-section>
      )}

      {fixes.length > 0 && (
        <s-section heading="Fix history">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Each fix saves Shopify&apos;s old values. Undo puts them back for{" "}
              {UNDO_DAYS} days, except values changed in Shopify since. See every
              change, and undo single ones, on the{" "}
              <s-link onClick={() => navigate(`/app/history?provider=${provider.id}`)}>
                History
              </s-link>{" "}
              page.
            </s-text>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">When</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="secondary">Result</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {fixes.map((b) => (
                  <s-table-row key={b.id}>
                    <s-table-cell>
                      {new Date(b.createdAt).toLocaleString()}
                      {b.source === "sync" ? " · scheduled" : ""}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={fixStatus(b).tone}>{fixStatus(b).label}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{fixSummary(b)}</s-table-cell>
                    <s-table-cell>
                      {b.undoable > 0 ? (
                        <s-button
                          variant="tertiary"
                          commandFor="undo-modal"
                          command="--show"
                          disabled={activeFix !== null}
                          onClick={() => setUndoId(b.id)}
                        >
                          Undo
                        </s-button>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {problems.length > 0 && (
              <s-stack direction="block" gap="small">
                <s-heading>Not changed</s-heading>
                <s-unordered-list>
                  {problems.map((i) => (
                    <s-list-item key={i.id}>
                      {i.label} ({i.sku}), {FIELD_LABEL[i.field].toLowerCase()}:{" "}
                      {i.error ?? "not changed"}
                    </s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      <ConnectModal provider={provider} reconnect onConnected={() => {}} />

      {comparison?.status === "done" && (
        <FixModal
          preview={fixPreview}
          counts={counts}
          providerId={provider.id}
          providerName={provider.name}
          canWrite={canWrite}
        />
      )}
      <UndoModal
        batch={fixes.find((b) => b.id === undoId) ?? null}
        providerId={provider.id}
      />

      <SyncSettings
        key={JSON.stringify(sync)}
        sync={sync}
        providerId={provider.id}
        providerName={provider.name}
        canWrite={canWrite}
      />

      <s-section slot="aside" heading="Connection">
        <s-stack direction="block" gap="base">
          <s-badge tone="success">Connected to {provider.name}</s-badge>
          <s-button variant="tertiary" commandFor={modalId(provider.id)} command="--show">
            Update connection
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            disabled={running}
            onClick={() => submit({ intent: "disconnect" })}
          >
            Disconnect
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Shopify catalog">
        <s-stack direction="block" gap="small">
          <s-text>
            {catalogReady
              ? `${catalogCount.toLocaleString()} variants, read ${new Date(scannedAt ?? "").toLocaleString()}`
              : "Reading…"}
          </s-text>
          <s-button
            variant="tertiary"
            disabled={catalogScan.running || running}
            onClick={catalogScan.rescan}
          >
            Refresh catalog
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it compares">
        <s-unordered-list>
          <s-list-item>Matches on SKU, ignoring case</s-list-item>
          <s-list-item>
            {provider.comparesCost
              ? "Weight in pounds and cost to the cent"
              : "Weight in pounds and barcode"}
          </s-list-item>
          {provider.compareNotes.map((note) => (
            <s-list-item key={note}>{note}</s-list-item>
          ))}
          <s-list-item>Archived products are skipped</s-list-item>
          <s-list-item>
            Nothing changes in Shopify unless you choose Fix (or a scheduled
            sync you set up does); {provider.name} is never changed
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

type Compare = Extract<Loaded, { view: "compare" }>;
type FixRow = Compare["fixes"][number];

const PREVIEW_ROWS = 25;

/** Popout: choose which fields to copy from the warehouse, preview, apply. */
function FixModal({
  preview,
  counts: allCounts,
  providerId,
  providerName,
  canWrite,
}: {
  preview: Mismatch[];
  counts: Record<MismatchCode, { total: number; fixable: number }> | null;
  providerId: string;
  providerName: string;
  canWrite: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const counts = Object.fromEntries(
    FIX_FIELDS.map((f) => [f, allCounts?.[`${f}_mismatch` as MismatchCode].fixable ?? 0]),
  ) as Record<FixField, number>;
  const [fields, setFields] = useState<FixField[]>(() => FIX_FIELDS.filter((f) => counts[f] > 0));
  const chosen = useMemo(
    () => preview.filter((m) => {
      const field = fixableField(m);
      return field !== null && fields.includes(field);
    }),
    [preview, fields],
  );
  const chosenTotal = fields.reduce((n, f) => n + counts[f], 0);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) hideModal("fix-modal");
  }, [fetcher.data, shopify]);

  return (
    <s-modal id="fix-modal" heading="Fix in Shopify" size="large">
      <s-stack direction="block" gap="base">
        {!canWrite && (
          <s-banner tone="warning" heading="Permission needed">
            Fixing needs permission to edit products. Approve SKU Doctor&apos;s
            updated permissions when Shopify asks, then reopen this page.
          </s-banner>
        )}
        <s-paragraph>
          Copy {providerName}&apos;s values into Shopify. SKU Doctor saves each
          old value first, so you can undo this from Fix history.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          {FIX_FIELDS.map((f) => (
            <s-checkbox
              key={f}
              label={`${FIELD_LABEL[f]} (${counts[f].toLocaleString()})`}
              checked={fields.includes(f)}
              disabled={counts[f] === 0}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setFields((list) => (on ? [...list, f] : list.filter((x) => x !== f)));
              }}
            />
          ))}
        </s-stack>
        {chosenTotal > 0 ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">SKU</s-table-header>
              <s-table-header listSlot="inline">Field</s-table-header>
              <s-table-header>Shopify now</s-table-header>
              <s-table-header>Becomes</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {chosen.slice(0, PREVIEW_ROWS).map((m) => (
                <s-table-row key={`${m.variantId}-${m.code}`}>
                  <s-table-cell>{m.label}</s-table-cell>
                  <s-table-cell>{m.sku}</s-table-cell>
                  <s-table-cell>{FIELD_LABEL[fixableField(m)!]}</s-table-cell>
                  <s-table-cell>{m.shopify}</s-table-cell>
                  <s-table-cell>{m.wms}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>Choose at least one field.</s-paragraph>
        )}
        {chosenTotal > Math.min(chosen.length, PREVIEW_ROWS) && (
          <s-text color="subdued">
            …and {(chosenTotal - Math.min(chosen.length, PREVIEW_ROWS)).toLocaleString()} more. Export the
            results (CSV) to see every change.
          </s-text>
        )}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!canWrite || chosenTotal === 0}
        onClick={() =>
          fetcher.submit(
            { intent: "fix", provider: providerId, fields: fields.join(",") },
            { method: "POST" },
          )
        }
        {...(busy ? { loading: true } : {})}
      >
        Fix {chosenTotal.toLocaleString()} values
      </s-button>
      <s-button slot="secondary-actions" commandFor="fix-modal" command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}

function UndoModal({ batch, providerId }: { batch: FixRow | null; providerId: string }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) hideModal("undo-modal");
  }, [fetcher.data, shopify]);

  return (
    <s-modal id="undo-modal" heading="Undo this fix?">
      <s-paragraph>
        {batch
          ? `Puts Shopify's old values back for the ${batch.undoable.toLocaleString()} values this fix set on ${new Date(batch.createdAt).toLocaleString()} that aren't undone yet. Values changed in Shopify since then are left alone.`
          : "Choose a fix to undo."}
      </s-paragraph>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        disabled={!batch}
        onClick={() =>
          batch &&
          fetcher.submit(
            { intent: "undo", provider: providerId, batchId: batch.id },
            { method: "POST" },
          )
        }
        {...(busy ? { loading: true } : {})}
      >
        Undo fix
      </s-button>
      <s-button slot="secondary-actions" commandFor="undo-modal" command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}

/** Aside: run this comparison on a schedule, optionally fixing chosen fields. */
function SyncSettings({
  sync,
  providerId,
  providerName,
  canWrite,
}: {
  sync: Compare["sync"];
  providerId: string;
  providerName: string;
  canWrite: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [enabled, setEnabled] = useState(sync.enabled);
  const [frequency, setFrequency] = useState(sync.frequency);
  const [fields, setFields] = useState<FixField[]>(sync.fixFields);
  const [syncScope, setSyncScope] = useState<Scope>(sync.scope);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  const status =
    sync.stage !== "idle"
      ? `Running now (${sync.stage === "scanning" ? "reading the catalog" : sync.stage})`
      : sync.lastRunAt
        ? `Last run ${new Date(sync.lastRunAt).toLocaleString()}${sync.lastMessage ? `: ${sync.lastMessage}` : ""}`
        : null;

  return (
    <s-section slot="aside" heading="Scheduled sync">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          Re-reads your catalog and compares it with {providerName} on a schedule,
          even when SKU Doctor isn&apos;t open.
        </s-text>
        <s-checkbox
          label="Run on a schedule"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        <s-select
          label="How often"
          value={frequency}
          disabled={!enabled}
          onChange={(e) => setFrequency(e.currentTarget.value)}
        >
          {(Object.keys(FREQUENCIES) as Frequency[]).map((f) => (
            <s-option key={f} value={f}>
              {FREQUENCIES[f].label}
            </s-option>
          ))}
        </s-select>
        <s-select
          label="Products to compare"
          value={syncScope}
          disabled={!enabled}
          onChange={(e) => setSyncScope(e.currentTarget.value as Scope)}
        >
          <s-option value="active">Active products</s-option>
          <s-option value="active_draft">Active and draft products</s-option>
        </s-select>
        <s-stack direction="block" gap="small-200">
          <s-text>Also fix in Shopify automatically:</s-text>
          {FIX_FIELDS.map((f) => (
            <s-checkbox
              key={f}
              label={FIELD_LABEL[f]}
              checked={fields.includes(f)}
              disabled={!enabled || !canWrite}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setFields((list) => (on ? [...list, f] : list.filter((x) => x !== f)));
              }}
            />
          ))}
          <s-text color="subdued">
            Automatic fixes appear in Fix history and can be undone.
          </s-text>
        </s-stack>
        <s-button
          onClick={() =>
            fetcher.submit(
              {
                intent: "saveSync",
                provider: providerId,
                enabled: String(enabled),
                frequency,
                fixFields: fields.join(","),
                scope: syncScope,
              },
              { method: "POST" },
            )
          }
          {...(busy ? { loading: true } : {})}
        >
          Save schedule
        </s-button>
        {status && <s-text color="subdued">{status}</s-text>}
        {sync.enabled && sync.nextRunAt && sync.stage === "idle" && (
          <s-text color="subdued">Next run {new Date(sync.nextRunAt).toLocaleString()}</s-text>
        )}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
