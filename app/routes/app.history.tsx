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
import { runInBackground } from "../lib/background.server";
import { authenticate } from "../shopify.server";
import { getPlan, planSelectionUrl } from "../lib/plans.server";
import { canUseWarehouse } from "../lib/plans";
import { UpgradeSection } from "../components/Upgrade";
import {
  CHANGE_STATUS,
  fixStatus,
  fixSummary,
  formatFixValue,
  hideModal,
} from "../components/fixes";
import { count, downloadFile, numericId, toCsv } from "../lib/catalog";
import { FIELD_LABEL, UNDO_DAYS, type FixField } from "../lib/fixes";
import {
  activeFix,
  advanceFix,
  batchRows,
  pruneHistory,
  startUndo,
} from "../lib/fixes.server";
import { isListed, PROVIDERS } from "../lib/wms/index.server";

// Every comparison and fix (manual or scheduled) across warehouse systems, and
// every value SKU Doctor changed, with undo for whole runs or single changes.

const PAGE = 50;
const STATUS_FILTERS = {
  all: { label: "All", statuses: undefined },
  applied: { label: "Can undo", statuses: ["applied"] },
  undone: { label: "Undone", statuses: ["reverted"] },
  problems: { label: "Failed or kept", statuses: ["failed", "kept", "undo_failed"] },
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

function params(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  return {
    tab: url.searchParams.get("tab") === "changes" ? ("changes" as const) : ("runs" as const),
    provider: url.searchParams.get("provider") || null,
    run: url.searchParams.get("run") || null,
    status: (status in STATUS_FILTERS ? status : "all") as StatusFilter,
    limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || PAGE, PAGE), 2000),
  };
}

/** Changes matching the filters, newest fix first. */
async function findChanges(
  shop: string,
  f: { provider: string | null; run: string | null; status: StatusFilter },
  take: number,
) {
  const batches = await prisma.fixBatch.findMany({
    where: {
      shop,
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.run ? { id: f.run } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  const statuses = STATUS_FILTERS[f.status].statuses;
  // Newest fix first; within a fix, by SKU.
  const items: Awaited<ReturnType<typeof prisma.fixItem.findMany>> = [];
  for (const batch of batches) {
    if (items.length > take) break;
    items.push(
      ...(await prisma.fixItem.findMany({
        where: { batchId: batch.id, ...(statuses ? { status: { in: [...statuses] } } : {}) },
        orderBy: [{ sku: "asc" }, { field: "asc" }],
        take: take + 1 - items.length,
      })),
    );
  }
  const byId = new Map(batches.map((b) => [b.id, b]));
  const cutoff = Date.now() - UNDO_DAYS * 86_400_000;
  return {
    more: items.length > take,
    rows: items.slice(0, take).map((i) => {
      const batch = byId.get(i.batchId)!;
      const field = i.field as FixField;
      return {
        id: i.id,
        batchId: i.batchId,
        at: batch.createdAt.toISOString(),
        provider: batch.provider,
        source: batch.source,
        productId: i.productId,
        variantId: i.variantId,
        label: i.label,
        sku: i.sku,
        field,
        before: formatFixValue(field, i.oldValue),
        after: formatFixValue(field, i.newValue),
        status: i.status,
        error: i.error,
        undoable:
          i.status === "applied" &&
          (batch.status === "done" || batch.status === "failed") &&
          batch.createdAt.getTime() > cutoff,
      };
    }),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!canUseWarehouse(await getPlan(session.shop, admin))) {
    return { locked: true as const, upgradeUrl: planSelectionUrl(session.shop) };
  }
  const { shop } = session;
  const f = params(request);
  await pruneHistory(shop);

  const providers = Object.values(PROVIDERS)
    .filter((p) => isListed(p.id))
    .map((p) => ({ id: p.id, name: p.name }));
  const active = await activeFix(shop);
  const base = {
    locked: false as const,
    filters: f,
    providers,
    undoDays: UNDO_DAYS,
    active: active && { id: active.id, status: active.status },
  };

  if (f.tab === "changes") {
    const changes = await findChanges(shop, f, f.limit);
    const runBatch = f.run ? await prisma.fixBatch.findUnique({ where: { id: f.run } }) : null;
    return {
      ...base,
      tab: "changes" as const,
      runLabel: runBatch && runBatch.shop === shop ? runBatch.createdAt.toISOString() : null,
      ...changes,
    };
  }

  // Runs: comparisons (each with the fixes made from it), plus scheduled runs
  // that stopped before comparing.
  const providerWhere = f.provider ? { provider: f.provider } : {};
  const [comparisons, syncRuns] = await Promise.all([
    prisma.wmsComparison.findMany({
      where: { shop, ...providerWhere },
      orderBy: { startedAt: "desc" },
      take: f.limit + 1,
    }),
    prisma.syncRun.findMany({
      where: { shop, ...providerWhere },
      orderBy: { startedAt: "desc" },
      take: f.limit + 1,
    }),
  ]);
  const batches = await batchRows(
    await prisma.fixBatch.findMany({
      where: { shop, comparisonId: { in: comparisons.map((c) => c.id) } },
      orderBy: { createdAt: "asc" },
    }),
  );
  const scheduled = new Map(
    syncRuns.filter((r) => r.comparisonId).map((r) => [r.comparisonId!, r]),
  );

  const runs = [
    ...comparisons.map((c) => ({
      key: c.id,
      at: c.startedAt.toISOString(),
      provider: c.provider,
      source: scheduled.has(c.id) ? ("sync" as const) : ("manual" as const),
      status: c.status,
      checked: c.checked,
      total: c.total,
      differences: c.status === "done" ? c.mismatchCount : null,
      message: c.error ?? scheduled.get(c.id)?.message ?? null,
      fixes: batches.filter((b) => b.comparisonId === c.id),
    })),
    ...syncRuns
      .filter((r) => !r.comparisonId)
      .map((r) => ({
        key: r.id,
        at: r.startedAt.toISOString(),
        provider: r.provider,
        source: "sync" as const,
        status: r.status,
        checked: 0,
        total: 0,
        differences: null,
        message: r.message,
        fixes: [],
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    ...base,
    tab: "runs" as const,
    more: runs.length > f.limit,
    runs: runs.slice(0, f.limit),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!canUseWarehouse(await getPlan(session.shop, admin))) {
    return { ok: false, message: "History is part of the Warehouse plan" };
  }
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "undoBatch" || intent === "undoItems") {
    const result =
      intent === "undoBatch"
        ? await startUndo(session.shop, { batchId: String(form.get("batchId") ?? "") })
        : await startUndo(session.shop, {
            itemIds: String(form.get("itemIds") ?? "").split(",").filter(Boolean),
          });
    if (result.error) return { ok: false, message: result.error };
    const active = await activeFix(session.shop);
    if (active) await runInBackground({ batchId: active.id });
    return { ok: true, message: `Undoing ${result.count?.toLocaleString()} changes` };
  }

  if (intent === "export") {
    const f = params(request);
    const { rows } = await findChanges(session.shop, f, 20_000);
    return { ok: true, message: "", rows };
  }

  if (intent === "step") {
    const fix = await activeFix(session.shop);
    if (fix) await advanceFix(fix.id, admin);
    return { ok: true, message: "" };
  }

  return { ok: false, message: "Unknown action" };
};

type Data = Extract<ReturnType<typeof useLoaderData<typeof loader>>, { locked: false }>;
type Runs = Extract<Data, { tab: "runs" }>;
type Changes = Extract<Data, { tab: "changes" }>;
type UndoTarget = { kind: "batch"; batchId: string; count: number } | { kind: "items"; itemIds: string[] };

export default function HistoryPage() {
  const data = useLoaderData<typeof loader>();
  if (data.locked) {
    return (
      <s-page heading="History">
        <UpgradeSection feature="History" needs="warehouse" upgradeUrl={data.upgradeUrl} />
      </s-page>
    );
  }
  return <HistoryLoaded {...data} />;
}

function HistoryLoaded(data: Data) {
  const navigate = useNavigate();
  const stepper = useFetcher<typeof action>();
  const exporter = useFetcher<typeof action>();
  const [undo, setUndo] = useState<UndoTarget | null>(null);
  const { filters, providers } = data;
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  const go = (change: Partial<Record<keyof typeof filters, string | null>>) => {
    const next = { ...filters, limit: null, ...change } as Record<string, string | number | null>;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v !== null && v !== "" && !(k === "status" && v === "all") && !(k === "tab" && v === "runs")) {
        qs.set(k, String(v));
      }
    }
    navigate(`/app/history${qs.size ? `?${qs}` : ""}`);
  };

  // Undo runs in steps while this page is open (like on the Warehouse page).
  const stepping = data.active !== null;
  useEffect(() => {
    if (!stepping) return;
    const tick = () => {
      if (stepper.state === "idle") stepper.submit({ intent: "step" }, { method: "POST" });
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [stepping, stepper]);

  useEffect(() => {
    const rows = exporter.data && "rows" in exporter.data ? exporter.data.rows : null;
    if (!rows) return;
    downloadFile(
      `sku-doctor-changes-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ["Date", "System", "Source", "Product", "SKU", "Field", "Before", "After", "Status", "Note", "Product ID", "Variant ID"],
        rows.map((r) => [
          new Date(r.at).toLocaleString(),
          name(r.provider),
          r.source === "sync" ? "Scheduled" : "Manual",
          r.label,
          r.sku,
          FIELD_LABEL[r.field],
          r.before,
          r.after,
          CHANGE_STATUS[r.status]?.label ?? r.status,
          r.error ?? "",
          numericId(r.productId),
          numericId(r.variantId),
        ]),
      ),
      "text/csv;charset=utf-8",
    );
    // name only changes with the provider list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporter.data]);

  return (
    <s-page heading="History">
      {data.tab === "changes" && (
        <s-button
          slot="secondary-actions"
          onClick={() =>
            exporter.submit(
              { intent: "export" },
              { method: "POST", action: `/app/history${window.location.search}` },
            )
          }
          {...(exporter.state !== "idle" ? { loading: true } : {})}
        >
          Export changes (CSV)
        </s-button>
      )}

      {data.active && (
        <s-banner tone="info">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Working" size="base" />
            <s-text>
              {data.active.status === "undoing" ? "Undoing changes" : "Fixing values in Shopify"}.
              It keeps running in the background, so you can leave this page.
            </s-text>
          </s-stack>
        </s-banner>
      )}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-stack direction="inline" gap="small-200">
            <s-clickable-chip
              color={data.tab === "runs" ? "strong" : "base"}
              onClick={() => go({ tab: "runs", run: null, status: "all" })}
            >
              Runs
            </s-clickable-chip>
            <s-clickable-chip
              color={data.tab === "changes" ? "strong" : "base"}
              onClick={() => go({ tab: "changes" })}
            >
              Changes
            </s-clickable-chip>
          </s-stack>
          <s-select
            label="Warehouse system"
            value={filters.provider ?? ""}
            onChange={(e) => go({ provider: e.currentTarget.value || null, run: null })}
          >
            <s-option value="">All systems</s-option>
            {providers.map((p) => (
              <s-option key={p.id} value={p.id}>
                {p.name}
              </s-option>
            ))}
          </s-select>
          {data.tab === "changes" && (
            <s-select
              label="Show"
              value={filters.status}
              onChange={(e) => go({ status: e.currentTarget.value })}
            >
              {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((k) => (
                <s-option key={k} value={k}>
                  {STATUS_FILTERS[k].label}
                </s-option>
              ))}
            </s-select>
          )}
        </s-stack>
      </s-section>

      {data.tab === "runs" ? (
        <RunsList
          data={data}
          name={name}
          onUndo={(batchId, count) => setUndo({ kind: "batch", batchId, count })}
          onShowChanges={(run) => go({ tab: "changes", run, status: "all" })}
          onMore={() => go({ limit: String(filters.limit + PAGE) })}
        />
      ) : (
        <ChangesList
          data={data}
          name={name}
          onUndo={(itemIds) => setUndo({ kind: "items", itemIds })}
          onClearRun={() => go({ run: null })}
          onMore={() => go({ limit: String(filters.limit + PAGE) })}
        />
      )}

      <UndoModal target={undo} />

      <s-section slot="aside" heading="About history">
        <s-unordered-list>
          <s-list-item>Runs lists every comparison, manual or scheduled, and the fixes made from it</s-list-item>
          <s-list-item>Changes lists every value SKU Doctor set in Shopify, with the value it replaced</s-list-item>
          <s-list-item>
            Undo puts old values back for {data.undoDays} days, for a whole run or the
            changes you select; values changed in Shopify since are left alone
          </s-list-item>
          <s-list-item>History older than {data.undoDays} days is deleted</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

function RunsList({
  data,
  name,
  onUndo,
  onShowChanges,
  onMore,
}: {
  data: Runs;
  name: (id: string) => string;
  onUndo: (batchId: string, count: number) => void;
  onShowChanges: (batchId: string) => void;
  onMore: () => void;
}) {
  if (data.runs.length === 0) {
    return (
      <s-section>
        <s-paragraph>
          No runs yet. Run a comparison on the Warehouse page, or turn on a scheduled sync.
        </s-paragraph>
      </s-section>
    );
  }
  return (
    <s-section heading="Runs">
      <s-stack direction="block" gap="base">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">When</s-table-header>
            <s-table-header listSlot="secondary">System</s-table-header>
            <s-table-header listSlot="inline">Comparison</s-table-header>
            <s-table-header>Fixes</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.runs.map((r) => (
              <s-table-row key={r.key}>
                <s-table-cell>
                  {new Date(r.at).toLocaleString()}
                  {r.source === "sync" ? " · scheduled" : ""}
                </s-table-cell>
                <s-table-cell>{name(r.provider)}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-200">
                    <s-badge tone={RUN_TONE[r.status] ?? "neutral"}>{RUN_LABEL[r.status] ?? r.status}</s-badge>
                    <s-text>
                      {r.differences !== null
                        ? `${count(r.total, "SKU")}, ${count(r.differences, "difference")}`
                        : r.status === "running"
                          ? `${r.checked.toLocaleString()} of ${r.total.toLocaleString()} checked`
                          : (r.message ?? "")}
                    </s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {r.fixes.length === 0 ? (
                    "—"
                  ) : (
                    <s-stack direction="block" gap="small-200">
                      {r.fixes.map((b) => (
                        <s-stack key={b.id} direction="inline" gap="small-200" alignItems="center">
                          <s-badge tone={fixStatus(b).tone}>{fixStatus(b).label}</s-badge>
                          <s-text>{fixSummary(b)}</s-text>
                        </s-stack>
                      ))}
                    </s-stack>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-200">
                    {r.fixes.map((b) => (
                      <s-stack key={b.id} direction="inline" gap="small-200">
                        <s-button variant="tertiary" onClick={() => onShowChanges(b.id)}>
                          Changes
                        </s-button>
                        {b.undoable > 0 && (
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            commandFor="undo-modal"
                            command="--show"
                            disabled={data.active !== null}
                            onClick={() => onUndo(b.id, b.undoable)}
                          >
                            Undo
                          </s-button>
                        )}
                      </s-stack>
                    ))}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {data.more && <s-button onClick={onMore}>Show more</s-button>}
      </s-stack>
    </s-section>
  );
}

const RUN_LABEL: Record<string, string> = {
  running: "Running",
  done: "Compared",
  failed: "Failed",
  skipped: "Skipped",
};
const RUN_TONE: Record<string, "info" | "success" | "critical" | "neutral"> = {
  running: "info",
  done: "success",
  failed: "critical",
  skipped: "neutral",
};

function ChangesList({
  data,
  name,
  onUndo,
  onClearRun,
  onMore,
}: {
  data: Changes;
  name: (id: string) => string;
  onUndo: (itemIds: string[]) => void;
  onClearRun: () => void;
  onMore: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const undoable = useMemo(() => data.rows.filter((r) => r.undoable), [data.rows]);
  const chosen = undoable.filter((r) => selected.has(r.id));
  const allChosen = undoable.length > 0 && chosen.length === undoable.length;

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <s-section heading="Changes">
      <s-stack direction="block" gap="base">
        {data.runLabel && (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text>Showing the fix from {new Date(data.runLabel).toLocaleString()}</s-text>
            <s-button variant="tertiary" onClick={onClearRun}>
              Show all fixes
            </s-button>
          </s-stack>
        )}
        {data.rows.length === 0 ? (
          <s-paragraph>No changes match.</s-paragraph>
        ) : (
          <>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-checkbox
                label={`Select all that can be undone (${undoable.length.toLocaleString()})`}
                checked={allChosen}
                disabled={undoable.length === 0}
                onChange={(e) =>
                  setSelected(e.currentTarget.checked ? new Set(undoable.map((r) => r.id)) : new Set())
                }
              />
              <s-button
                tone="critical"
                commandFor="undo-modal"
                command="--show"
                disabled={chosen.length === 0 || data.active !== null}
                onClick={() => onUndo(chosen.map((r) => r.id))}
              >
                Undo selected ({chosen.length.toLocaleString()})
              </s-button>
            </s-stack>
            <s-table>
              <s-table-header-row>
                <s-table-header>Undo</s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">SKU</s-table-header>
                <s-table-header>Field</s-table-header>
                <s-table-header>Before</s-table-header>
                <s-table-header>After</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header>When</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.rows.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      {r.undoable ? (
                        <s-checkbox
                          accessibilityLabel={`Select ${r.sku} ${FIELD_LABEL[r.field]}`}
                          checked={selected.has(r.id)}
                          onChange={(e) => toggle(r.id, e.currentTarget.checked)}
                        />
                      ) : null}
                    </s-table-cell>
                    <s-table-cell>
                      <s-link
                        href={`shopify://admin/products/${numericId(r.productId)}/variants/${numericId(r.variantId)}`}
                        target="_blank"
                      >
                        {r.label}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{r.sku}</s-table-cell>
                    <s-table-cell>{FIELD_LABEL[r.field]}</s-table-cell>
                    <s-table-cell>{r.before}</s-table-cell>
                    <s-table-cell>{r.after}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        <s-badge tone={CHANGE_STATUS[r.status]?.tone ?? "neutral"}>
                          {CHANGE_STATUS[r.status]?.label ?? r.status}
                        </s-badge>
                        {r.error && <s-text color="subdued">{r.error}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(r.at).toLocaleString()} · {name(r.provider)}
                      {r.source === "sync" ? " (scheduled)" : ""}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {data.more && <s-button onClick={onMore}>Show more</s-button>}
          </>
        )}
      </s-stack>
    </s-section>
  );
}

function UndoModal({ target }: { target: UndoTarget | null }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const count = target ? (target.kind === "batch" ? target.count : target.itemIds.length) : 0;

  useEffect(() => {
    if (!fetcher.data || !fetcher.data.message) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) hideModal("undo-modal");
  }, [fetcher.data, shopify]);

  return (
    <s-modal id="undo-modal" heading="Undo changes?">
      <s-paragraph>
        Puts Shopify&apos;s old values back for {count.toLocaleString()}{" "}
        {count === 1 ? "change" : "changes"}. Values changed in Shopify since
        SKU Doctor set them are left alone.
      </s-paragraph>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        disabled={!target}
        onClick={() => {
          if (!target) return;
          fetcher.submit(
            target.kind === "batch"
              ? { intent: "undoBatch", batchId: target.batchId }
              : { intent: "undoItems", itemIds: target.itemIds.join(",") },
            { method: "POST" },
          );
        }}
        {...(busy ? { loading: true } : {})}
      >
        Undo {count.toLocaleString()} {count === 1 ? "change" : "changes"}
      </s-button>
      <s-button slot="secondary-actions" commandFor="undo-modal" command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
