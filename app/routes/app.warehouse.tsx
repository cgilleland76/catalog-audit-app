import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { fetchCatalog } from "../lib/catalog.server";
import { downloadFile, numericId, toCsv } from "../lib/catalog";
import {
  PROVIDERS,
  deleteCredentials,
  failStaleComparisons,
  getProvider,
  loadCredentials,
  providerInfo,
  saveCredentials,
  startComparison,
} from "../lib/wms/index.server";
import {
  MISMATCH_INFO,
  type Mismatch,
  type MismatchCode,
} from "../lib/wms/types";

const providerFrom = (request: Request) =>
  new URL(request.url).searchParams.get("provider") ??
  Object.keys(PROVIDERS)[0];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const provider = getProvider(providerFrom(request));
  await failStaleComparisons(session.shop);

  const credentials = await loadCredentials(session.shop, provider.id);
  const latest = await prisma.wmsComparison.findFirst({
    where: { shop: session.shop, provider: provider.id },
    orderBy: { startedAt: "desc" },
  });

  return {
    provider: providerInfo(provider),
    providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name })),
    connected: credentials !== null,
    comparison: latest && {
      id: latest.id,
      status: latest.status,
      checked: latest.checked,
      total: latest.total,
      error: latest.error,
      startedAt: latest.startedAt.toISOString(),
      finishedAt: latest.finishedAt?.toISOString() ?? null,
      results: latest.results ? (JSON.parse(latest.results) as Mismatch[]) : [],
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const provider = getProvider(providerFrom(request));
  const form = await request.formData();
  const intent = form.get("intent");

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

    const { rows } = await fetchCatalog(admin);
    const live = rows.filter((r) => r.status !== "ARCHIVED");
    const comparison = await prisma.wmsComparison.create({
      data: { shop: session.shop, provider: provider.id, status: "running" },
    });
    const total = startComparison(comparison.id, provider, credentials, live);
    await prisma.wmsComparison.update({
      where: { id: comparison.id },
      data: { total },
    });
    return { ok: true, message: `Checking ${total} SKUs in ${provider.name}` };
  }

  return { ok: false, message: "Unknown action" };
};

const PAGE_SIZE = 100;
const CODES = Object.keys(MISMATCH_INFO) as MismatchCode[];

export default function WarehousePage() {
  const { provider, connected, comparison } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<MismatchCode | "all">("weight_mismatch");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const busy = fetcher.state !== "idle";
  const running = comparison?.status === "running";

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  // Poll while a comparison runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [running, revalidator]);

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
    fetcher.submit(data, { method: "POST" });

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
      {connected && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={running || busy}
          onClick={() => submit({ intent: "compare" })}
          {...(busy && fetcher.formData?.get("intent") === "compare"
            ? { loading: true }
            : {})}
        >
          Run comparison
        </s-button>
      )}
      {comparison?.status === "done" && results.length > 0 && (
        <s-button slot="secondary-actions" onClick={exportCsv}>
          Export (CSV)
        </s-button>
      )}

      {!connected && (
        <s-section heading={`Connect ${provider.name}`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>{provider.setupHelp}</s-paragraph>
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
            <s-button
              variant="primary"
              onClick={() => submit({ intent: "connect", ...credentials })}
              {...(busy ? { loading: true } : {})}
            >
              Test and connect
            </s-button>
          </s-stack>
        </s-section>
      )}

      {connected && !comparison && (
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
              Checked {comparison.checked.toLocaleString()} of{" "}
              {comparison.total.toLocaleString()} SKUs in {provider.name}. You
              can leave this page; the comparison keeps running.
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
              {CODES.map((k) => (
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

      {connected && (
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
      )}

      <s-section slot="aside" heading="How it compares">
        <s-unordered-list>
          <s-list-item>Matches on SKU, ignoring case</s-list-item>
          <s-list-item>Weight in pounds and cost to the cent</s-list-item>
          <s-list-item>
            Kits with no weight or cost of their own use the sum of their
            components
          </s-list-item>
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
