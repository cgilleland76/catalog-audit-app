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
import { catalogForPage, loadCatalog } from "../lib/catalog.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { canUseWarehouse } from "../lib/plans";
import { UpgradeSection } from "../components/Upgrade";
import { ScanBanner, useCatalogScan } from "../components/CatalogScan";
import { downloadFile, numericId, toCsv } from "../lib/catalog";
import {
  PROVIDERS,
  deleteCredentials,
  getProvider,
  loadCredentials,
  providerInfo,
  saveCredentials,
  advanceComparison,
  createComparison,
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
  checked: number;
  total: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  results: string | null;
}) => ({
  status: c.status,
  checked: c.checked,
  total: c.total,
  error: c.error,
  startedAt: c.startedAt.toISOString(),
  finishedAt: c.finishedAt?.toISOString() ?? null,
  differences: c.results ? (JSON.parse(c.results) as Mismatch[]).length : 0,
});

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
      systems: Object.values(PROVIDERS).map((p) => {
        const comparison = latest.find((c) => c.provider === p.id);
        return {
          ...providerInfo(p),
          connected: connections.some((c) => c.provider === p.id),
          comparison: comparison ? summarize(comparison) : null,
        };
      }),
    };
  }

  const provider = getProvider(param);
  const catalog = await catalogForPage(session.shop, admin);
  const latest = await prisma.wmsComparison.findFirst({
    where: { shop: session.shop, provider: provider.id },
    orderBy: { startedAt: "desc" },
  });

  return {
    locked: false as const,
    view: "compare" as const,
    provider: providerInfo(provider),
    catalogCount: catalog.rows?.length ?? null,
    scannedAt: catalog.scannedAt,
    scan: catalog.scan,
    comparison: latest && {
      id: latest.id,
      ...summarize(latest),
      results: latest.results ? (JSON.parse(latest.results) as Mismatch[]) : [],
    },
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
    return { ok: true, message: `Disconnected ${provider.name}` };
  }

  if (intent === "compare") {
    const credentials = await loadCredentials(session.shop, provider.id);
    if (!credentials) return { ok: false, message: "Connect first" };

    const running = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "running" },
    });
    if (running) return { ok: false, message: "A comparison is already running" };

    const catalog = await loadCatalog(session.shop);
    if (!catalog) {
      return { ok: false, message: "Your catalog is still being read; try again in a minute" };
    }
    const live = catalog.rows.filter((r) => r.status !== "ARCHIVED");
    const comparison = await createComparison(session.shop, provider, live);
    return {
      ok: true,
      message: `Checking ${comparison.total} SKUs in ${provider.name}`,
    };
  }

  // Runs the next few seconds of a comparison; the page calls this while it
  // polls, so a comparison only advances while the page is open.
  if (intent === "step") {
    const running = await prisma.wmsComparison.findFirst({
      where: { shop: session.shop, provider: provider.id, status: "running" },
    });
    if (running) {
      await advanceComparison(running.id, async () =>
        (await loadCatalog(session.shop))?.rows ?? null,
      );
    }
    return { ok: true, message: "" };
  }

  return { ok: false, message: "Unknown action" };
};

const PAGE_SIZE = 100;
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
  return `${c.differences.toLocaleString()} differences in ${c.total.toLocaleString()} SKUs · ${new Date(c.finishedAt ?? c.startedAt).toLocaleDateString()}`;
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
          <s-list-item>Read-only: nothing is changed in Shopify or your warehouse</s-list-item>
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
}: Extract<Loaded, { view: "compare" }>) {
  const catalogScan = useCatalogScan(initialScan, scannedAt);
  const catalogReady = catalogCount !== null;
  const fetcher = useFetcher<typeof action>();
  const stepper = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<MismatchCode | "all">("weight_mismatch");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const busy = fetcher.state !== "idle";
  const running = comparison?.status === "running";
  const codes = CODES.filter((k) => k !== "cost_mismatch" || provider.comparesCost);

  useEffect(() => {
    if (!fetcher.data) return;
    // After a disconnect the loader returns the list of systems by itself.
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  // While a comparison runs, keep asking the server to do the next step.
  // Each finished step re-runs the loader, which shows the new progress.
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (stepper.state === "idle") {
        stepper.submit({ intent: "step", provider: provider.id }, { method: "POST" });
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [running, stepper, provider.id]);

  const results = useMemo(() => comparison?.results ?? [], [comparison]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(CODES.map((k) => [k, 0])) as Record<
      MismatchCode,
      number
    >;
    for (const m of results) c[m.code]++;
    return c;
  }, [results]);
  const visible = useMemo(
    () => results.filter((m) => filter === "all" || m.code === filter),
    [results, filter],
  );

  const submit = (data: Record<string, string>) =>
    fetcher.submit({ ...data, provider: provider.id }, { method: "POST" });

  const exportCsv = () => {
    downloadFile(
      `${provider.id}-comparison-${(comparison?.startedAt ?? "").slice(0, 10)}.csv`,
      toCsv(
        ["Issue", "SKU", "Product", "Shopify", provider.name, "Product ID", "Variant ID"],
        visible.map((m) => [
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
  };

  return (
    <s-page heading={`${provider.name} comparison`}>
      <s-link slot="breadcrumb-actions" onClick={() => navigate("/app/warehouse")}>
        Warehouse systems
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={running || busy || !catalogReady}
        onClick={() => submit({ intent: "compare" })}
        {...(busy && fetcher.formData?.get("intent") === "compare"
          ? { loading: true }
          : {})}
      >
        Run comparison
      </s-button>
      <s-button slot="secondary-actions" onClick={() => navigate("/app/warehouse")}>
        All warehouse systems
      </s-button>
      {comparison?.status === "done" && results.length > 0 && (
        <s-button slot="secondary-actions" onClick={exportCsv}>
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

      {!comparison && (
        <s-section>
          <s-paragraph>
            Connected. Run a comparison to check every Shopify SKU against{" "}
            {provider.name}.
          </s-paragraph>
        </s-section>
      )}

      {running && comparison && (
        <s-section heading="Comparing…">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Comparing" />
            <s-text>
              {comparison.checked === 0 && comparison.total > 0
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
          {comparison.error}
        </s-banner>
      )}

      {comparison?.status === "done" && (
        <s-section heading="Results">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {comparison.total.toLocaleString()} SKUs checked ·{" "}
              {results.length.toLocaleString()} differences · finished{" "}
              {new Date(comparison.finishedAt ?? comparison.startedAt).toLocaleString()}
            </s-text>
            <s-stack direction="inline" gap="small-200">
              {codes.map((k) => (
                <s-clickable-chip
                  key={k}
                  color={filter === k ? "strong" : "base"}
                  onClick={() => {
                    setFilter(k);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  {MISMATCH_INFO[k].label} ({counts[k]})
                </s-clickable-chip>
              ))}
              <s-clickable-chip
                color={filter === "all" ? "strong" : "base"}
                onClick={() => {
                  setFilter("all");
                  setLimit(PAGE_SIZE);
                }}
              >
                All ({results.length})
              </s-clickable-chip>
            </s-stack>

            {visible.length === 0 ? (
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
                  {visible.slice(0, limit).map((m) => (
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
            {visible.length > limit && (
              <s-button onClick={() => setLimit(limit + PAGE_SIZE)}>
                Show more ({(visible.length - limit).toLocaleString()} left)
              </s-button>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Connection">
        <s-stack direction="block" gap="base">
          <s-badge tone="success">Connected to {provider.name}</s-badge>
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
          <s-list-item>Read-only: nothing is changed in either system</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
