import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { FIELD_OF, type FixField, UNDO_DAYS } from "./fixes";
import { TO_LB } from "./wms/index.server";

// "Fix in Shopify": copies warehouse values into Shopify, saving each old value
// first so the whole batch can be undone. Like comparisons, a batch advances in
// short steps (from the page while it polls, or from the scheduled sync).

type Weight = { value: number; unit: string };
type Value = Weight | { lb: number } | number | string | null;

const CURRENT_VALUES = `#graphql
  query FixCurrentValues($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        barcode
        product {
          id
        }
        inventoryItem {
          unitCost {
            amount
          }
          measurement {
            weight {
              value
              unit
            }
          }
        }
      }
    }
  }
`;

const UPDATE_VARIANTS = `#graphql
  mutation FixVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    # Without allowPartialUpdates, one rejected variant blocks every change to
    # the product; each change is read back afterwards either way.
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
      allowPartialUpdates: true
    ) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type VariantNode = {
  id: string;
  barcode: string | null;
  product: { id: string };
  inventoryItem: {
    unitCost: { amount: string } | null;
    measurement: { weight: Weight | null } | null;
  } | null;
};

const lbOf = (v: Value): number | null => {
  if (v === null || typeof v !== "object") return null;
  if ("lb" in v) return v.lb;
  return v.value * (TO_LB[v.unit] ?? 1);
};
const cents = (n: number) => Math.round(n * 100);

/** Whether Shopify's current value already equals `target`. */
export function sameValue(field: FixField, current: Value, target: Value) {
  if (field === "weight") {
    // Within half a hundredth of a pound: unit conversion and rounding to the
    // variant's own unit (e.g. kilograms) must not read as a different value.
    const a = lbOf(current) ?? 0;
    const b = lbOf(target) ?? 0;
    return Math.abs(a - b) < 0.005 + 1e-9;
  }
  if (field === "cost") {
    const a = typeof current === "number" ? current : 0;
    const b = typeof target === "number" ? target : 0;
    return cents(a) === cents(b);
  }
  return String(current ?? "").trim() === String(target ?? "").trim();
}

export function currentValue(field: FixField, node: VariantNode): Value {
  if (field === "weight") return node.inventoryItem?.measurement?.weight ?? null;
  if (field === "cost") {
    const amount = node.inventoryItem?.unitCost?.amount;
    return amount === undefined || amount === null ? null : Number(amount);
  }
  return node.barcode?.trim() || null;
}

/** Shopify input for writing `value`, keeping the variant's weight unit. */
export function variantInput(field: FixField, value: Value, node: VariantNode) {
  if (field === "weight") {
    const unit = node.inventoryItem?.measurement?.weight?.unit ?? "POUNDS";
    const weight =
      value && typeof value === "object" && "lb" in value
        ? { value: Number((value.lb / (TO_LB[unit] ?? 1)).toFixed(4)), unit }
        : ((value as Weight | null) ?? { value: 0, unit });
    return { inventoryItem: { measurement: { weight } } };
  }
  if (field === "cost") {
    return { inventoryItem: { cost: typeof value === "number" ? value.toFixed(2) : null } };
  }
  return { barcode: typeof value === "string" ? value : null };
}

const GRANTED_SCOPES = `#graphql
  query GrantedScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

/**
 * Whether the shop has granted the permissions fixing needs. Asks Shopify,
 * since the scopes saved with the session can be out of date after the app's
 * permissions change (development stores grant new ones without a prompt).
 */
export async function canWriteProducts(admin: AdminApiContext) {
  try {
    const response = await admin.graphql(GRANTED_SCOPES);
    const json = (await response.json()) as {
      data?: { currentAppInstallation: { accessScopes: { handle: string }[] } };
    };
    const granted = new Set(
      (json.data?.currentAppInstallation.accessScopes ?? []).map((s) => s.handle),
    );
    return granted.has("write_products") && granted.has("write_inventory");
  } catch {
    return false;
  }
}

class Throttled extends Error {}

async function gql<T>(admin: AdminApiContext, query: string, variables: Record<string, unknown>) {
  try {
    const response = await admin.graphql(query, { variables });
    const json = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      const message = json.errors.map((e) => e.message).join("; ");
      if (/throttl/i.test(message)) throw new Throttled(message);
      throw new Error(message);
    }
    return json.data as T;
  } catch (error) {
    if (error instanceof Throttled) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/throttl/i.test(message)) throw new Throttled(message);
    if (/access denied|write_products|write_inventory|scope/i.test(message)) {
      throw new Error(
        "SKU Doctor needs permission to edit products. Open SKU Doctor from your Shopify admin and approve the updated permissions, then try again.",
      );
    }
    console.error("[fix] Shopify request failed:", message);
    // Server or network trouble: say so plainly instead of showing Shopify's raw response.
    if (/networkStatusCode|internal error|fetch failed|ECONN|ETIMEDOUT|socket/i.test(message)) {
      throw new Error(
        "Shopify had a temporary problem saving changes. What was saved can be undone; run Fix again to finish the rest.",
      );
    }
    throw error;
  }
}

async function readVariants(admin: AdminApiContext, ids: string[]) {
  const data = await gql<{ nodes: (VariantNode | null)[] }>(admin, CURRENT_VALUES, { ids });
  const map = new Map<string, VariantNode>();
  for (const node of data.nodes) if (node?.id) map.set(node.id, node);
  return map;
}

/** Creates a batch for the chosen fields of a comparison's differences. */
export async function createFixBatch(opts: {
  shop: string;
  provider: string;
  comparisonId: string;
  fields: FixField[];
  source: "manual" | "sync";
}) {
  const active = await prisma.fixBatch.findFirst({
    where: { shop: opts.shop, status: { in: ["applying", "undoing"] } },
  });
  if (active) return { error: "Another fix is still running; wait for it to finish." };

  const codes = (Object.keys(FIELD_OF) as (keyof typeof FIELD_OF)[]).filter((code) =>
    opts.fields.includes(FIELD_OF[code]!),
  );
  const batch = await prisma.fixBatch.create({
    data: {
      shop: opts.shop,
      provider: opts.provider,
      comparisonId: opts.comparisonId,
      source: opts.source,
      status: "applying",
    },
  });
  // One item per fixable difference, straight from the comparison's table.
  // Weight targets are pounds, stored as { lb }; cost and barcode as is.
  const total = await prisma.$executeRaw`
    INSERT INTO "FixItem" ("id", "shop", "batchId", "variantId", "productId", "sku", "label", "field", "newValue", "status")
    SELECT gen_random_uuid()::text, "shop", ${batch.id}, "variantId", "productId", "sku", "label",
      CASE "code" WHEN 'weight_mismatch' THEN 'weight' WHEN 'cost_mismatch' THEN 'cost' ELSE 'barcode' END,
      CASE "code" WHEN 'weight_mismatch' THEN '{"lb":' || "target" || '}' ELSE "target" END,
      'pending'
    FROM "WmsMismatch"
    WHERE "comparisonId" = ${opts.comparisonId} AND "target" IS NOT NULL AND "code" = ANY(${codes})`;
  if (total === 0) {
    await prisma.fixBatch.delete({ where: { id: batch.id } });
    return { error: "Nothing to fix for the chosen fields." };
  }
  return { batch: await prisma.fixBatch.update({ where: { id: batch.id }, data: { total } }) };
}

/**
 * Starts undoing a whole batch, or just some of its changes (`itemIds`, which
 * may span several batches). Each batch then undoes in steps.
 */
export async function startUndo(shop: string, target: { batchId: string } | { itemIds: string[] }) {
  const active = await prisma.fixBatch.findFirst({
    where: { shop, status: { in: ["applying", "undoing"] } },
  });
  if (active) return { error: "Another fix is still running; wait for it to finish." };

  const undoable = await prisma.fixBatch.findMany({
    where: {
      shop,
      // "failed" batches (from before fixes ended "done" on errors) can still have applied changes.
      status: { in: ["done", "failed"] },
      createdAt: { gt: new Date(Date.now() - UNDO_DAYS * 86_400_000) },
      ...("batchId" in target ? { id: target.batchId } : {}),
    },
    select: { id: true },
  });
  const batchIds = undoable.map((b) => b.id);
  const marked = await prisma.fixItem.updateMany({
    where: {
      shop,
      batchId: { in: batchIds },
      status: "applied",
      ...("itemIds" in target ? { id: { in: target.itemIds } } : {}),
    },
    data: { status: "revert_pending" },
  });
  if (marked.count === 0) return { error: "Nothing here can be undone anymore." };

  const touched = await prisma.fixItem.findMany({
    where: { shop, batchId: { in: batchIds }, status: "revert_pending" },
    distinct: ["batchId"],
    select: { batchId: true },
  });
  await prisma.fixBatch.updateMany({
    where: { id: { in: touched.map((t) => t.batchId) } },
    data: { status: "undoing", finishedAt: null },
  });
  return { count: marked.count };
}

const STEP_MS = 6000;
// Longer than any step can take: steps stop starting new products near STEP_MS.
const LOCK_MS = 30000;
const CHUNK = 50;

type Item = Awaited<ReturnType<typeof prisma.fixItem.findMany>>[number];

/** Another step took over this batch (our lock expired); stop without saving. */
class LostLock extends Error {}

/**
 * Applies (or undoes) one chunk of items: read, write, read back to confirm.
 *
 * Old values are saved (status "writing") before anything is written to
 * Shopify, so a step that stops partway (throttled, timed out, error) never
 * loses what a value was. The next step resumes "writing" items: if Shopify
 * already has the new value it's applied, otherwise it's written again. An
 * interrupted undo resumes the same way: a value already back to the old one
 * counts as undone.
 */
async function processChunk(
  admin: AdminApiContext,
  items: Item[],
  undo: boolean,
  deadline: number,
  holdsLock: () => Promise<void>,
) {
  const before = await readVariants(admin, [...new Set(items.map((i) => i.variantId))]);
  const updates = new Map<string, Partial<Item>>();
  // productId -> variantId -> merged input
  const writes = new Map<string, Map<string, Record<string, unknown>>>();
  const targets: { item: Item; target: Value }[] = [];
  const presave: [string, Partial<Item>][] = [];

  for (const item of items) {
    const field = item.field as FixField;
    const node = before.get(item.variantId);
    if (!node) {
      updates.set(item.id, { status: undo ? "undo_failed" : "failed", error: "This variant no longer exists" });
      continue;
    }
    const current = currentValue(field, node);
    const written = JSON.parse(item.newValue) as Value;
    let target: Value;
    if (undo) {
      const old = item.oldValue ? (JSON.parse(item.oldValue) as Value) : null;
      // Already back to the old value (e.g. an earlier step was interrupted after writing).
      if (sameValue(field, current, old)) {
        updates.set(item.id, { status: "reverted", error: null });
        continue;
      }
      // Only undo what's still our value; leave later edits alone.
      if (!sameValue(field, current, written)) {
        updates.set(item.id, { status: "kept", error: "Changed in Shopify since the fix" });
        continue;
      }
      target = old;
    } else {
      if (item.status === "writing") {
        // Resumed: the old value was saved before an earlier write attempt.
        if (sameValue(field, current, written)) {
          updates.set(item.id, { status: "applied", error: null });
          continue;
        }
      } else {
        if (sameValue(field, current, written)) {
          updates.set(item.id, { oldValue: JSON.stringify(current), status: "unchanged" });
          continue;
        }
        presave.push([item.id, { oldValue: JSON.stringify(current), status: "writing" }]);
      }
      target = written;
    }

    const byVariant = writes.get(node.product.id) ?? new Map<string, Record<string, unknown>>();
    const input = byVariant.get(node.id) ?? { id: node.id };
    const add = variantInput(field, target, node);
    if (add.inventoryItem && input.inventoryItem) {
      input.inventoryItem = { ...(input.inventoryItem as object), ...add.inventoryItem };
    } else {
      Object.assign(input, add);
    }
    byVariant.set(node.id, input);
    writes.set(node.product.id, byVariant);
    targets.push({ item, target });
  }

  // Old values are saved before the first write.
  await holdsLock();
  if (presave.length) {
    await prisma.$transaction(
      presave.map(([id, data]) => prisma.fixItem.update({ where: { id }, data })),
    );
  }

  const save = () =>
    prisma.$transaction(
      [...updates].map(([id, data]) => prisma.fixItem.update({ where: { id }, data })),
    );

  const errors = new Map<string, string>(); // variantId -> message
  const done = new Set<string>(); // productIds written in this step
  try {
    for (const [productId, byVariant] of writes) {
      // Leave the rest for the next step rather than outlive the lock.
      if (Date.now() + 1500 > deadline) break;
      const variants = [...byVariant.values()];
      const data = await gql<{
        productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] } | null;
      }>(admin, UPDATE_VARIANTS, { productId, variants });
      done.add(productId);
      for (const e of data.productVariantsBulkUpdate?.userErrors ?? []) {
        const index = e.field?.[0] === "variants" ? Number(e.field[1]) : NaN;
        const ids = Number.isInteger(index) && variants[index] ? [String(variants[index].id)] : variants.map((v) => String(v.id));
        for (const id of ids) errors.set(id, [errors.get(id), e.message].filter(Boolean).join("; "));
      }
    }

    const written = targets.filter(({ item }) => {
      const node = before.get(item.variantId);
      return node && done.has(node.product.id);
    });
    if (written.length) {
      const after = await readVariants(admin, [...new Set(written.map((t) => t.item.variantId))]);
      for (const { item, target } of written) {
        const node = after.get(item.variantId);
        const ok = node && sameValue(item.field as FixField, currentValue(item.field as FixField, node), target);
        updates.set(item.id, {
          ...updates.get(item.id),
          status: ok ? (undo ? "reverted" : "applied") : undo ? "undo_failed" : "failed",
          error: ok ? null : errors.get(item.variantId) || "Shopify didn't save the change",
        });
      }
    }
  } finally {
    // Whatever was confirmed is saved even if a later write failed.
    await holdsLock();
    await save();
  }
  return [...updates.entries()]
    .filter(([, data]) => data.status)
    .map(([id, data]) => ({ item: items.find((i) => i.id === id)!, status: data.status as string }));
}

async function recount(batchId: string) {
  const groups = await prisma.fixItem.groupBy({ by: ["status"], where: { batchId }, _count: true });
  const n = (...statuses: string[]) =>
    groups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count, 0);
  return {
    // Everything the fix set (or found already set), including what was later undone.
    applied: n("applied", "revert_pending", "unchanged", "reverted", "kept", "undo_failed"),
    stillApplied: n("applied"),
    failed: n("failed"),
    reverted: n("reverted"),
    kept: n("kept"),
    pending: n("pending", "writing"),
  };
}

/**
 * Runs the next few seconds of an applying or undoing batch. Safe to call from
 * overlapping requests: only the step holding the batch's lock saves anything.
 */
export async function advanceFix(batchId: string, admin: AdminApiContext) {
  const now = new Date();
  const token = new Date(now.getTime() + LOCK_MS);
  const claimed = await prisma.fixBatch.updateMany({
    where: {
      id: batchId,
      status: { in: ["applying", "undoing"] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: token },
  });
  if (claimed.count === 0) return;

  // Confirms this step still holds the lock (the token is our lockedUntil).
  const holdsLock = async () => {
    const still = await prisma.fixBatch.count({ where: { id: batchId, lockedUntil: token } });
    if (!still) throw new LostLock();
  };

  const batch = await prisma.fixBatch.findUniqueOrThrow({ where: { id: batchId } });
  const undo = batch.status === "undoing";
  const deadline = Date.now() + STEP_MS;
  const changed: { item: Item; status: string }[] = [];
  let finished = false;
  let error: string | null = null;

  try {
    while (Date.now() + 2000 < deadline) {
      const items = await prisma.fixItem.findMany({
        where: { batchId, status: undo ? "revert_pending" : { in: ["pending", "writing"] } },
        orderBy: { id: "asc" },
        take: CHUNK,
      });
      if (items.length === 0) {
        finished = true;
        break;
      }
      changed.push(...(await processChunk(admin, items, undo, deadline, holdsLock)));
    }
  } catch (e) {
    if (e instanceof LostLock) return; // another step has the batch now
    // Throttled: the next step picks up where this one stopped.
    if (!(e instanceof Throttled)) error = e instanceof Error ? e.message : String(e);
  }

  if (changed.length) await updateSavedCopies(batch.shop, batch.comparisonId, changed, undo);

  if (error) {
    if (undo) {
      // Changes not undone yet stay applied, so they can be undone again later.
      await prisma.fixItem.updateMany({
        where: { batchId, status: "revert_pending" },
        data: { status: "applied" },
      });
    } else {
      // Stopped: items never tried are marked so; items mid-write keep their
      // saved old value and count as applied, so Undo can still restore them
      // (Undo leaves alone anything that isn't our value).
      await prisma.fixItem.updateMany({
        where: { batchId, status: "pending" },
        data: { status: "failed", error: "Not attempted: the fix stopped early" },
      });
      await prisma.fixItem.updateMany({
        where: { batchId, status: "writing" },
        data: { status: "applied", error: "Not confirmed: the fix stopped early" },
      });
    }
  }
  const counts = await recount(batchId);
  await prisma.fixBatch.updateMany({
    where: { id: batchId, lockedUntil: token },
    data: {
      applied: counts.applied,
      failed: counts.failed,
      reverted: counts.reverted,
      kept: counts.kept,
      lockedUntil: null,
      // A fix that stops on an error ends "done" with the error shown, so what
      // it did apply can still be undone.
      ...(error
        ? { status: "done", error, finishedAt: new Date() }
        : finished
          ? undo
            ? counts.stillApplied > 0
              ? { status: "done", undoneAt: new Date(), finishedAt: new Date() } // partly undone
              : { status: "undone", undoneAt: new Date(), finishedAt: new Date() }
            : { status: "done", finishedAt: new Date() }
          : {}),
    },
  });
}

/**
 * Keeps the saved catalog scan and comparison in step with what was written,
 * so pages show the fixed values without waiting for a new scan.
 */
async function updateSavedCopies(
  shop: string,
  comparisonId: string | null,
  changed: { item: Item; status: string }[],
  undo: boolean,
) {
  const done = changed.filter((c) => ["applied", "unchanged", "reverted"].includes(c.status));
  if (!done.length) return;

  const scan = await prisma.catalogScan.findFirst({
    where: { shop, status: "done" },
    orderBy: { startedAt: "desc" },
  });
  if (scan) {
    const rows = await prisma.catalogVariant.findMany({
      where: { scanId: scan.id, variantId: { in: [...new Set(done.map((d) => d.item.variantId))] } },
    });
    const byId = new Map(rows.map((r) => [r.variantId, r]));
    const updates = [];
    for (const { item } of done) {
      const row = byId.get(item.variantId);
      if (!row) continue;
      const raw = undo ? item.oldValue : item.newValue;
      const value = raw ? (JSON.parse(raw) as Value) : null;
      if (item.field === "weight") {
        const lb = lbOf(value);
        const unit =
          value && typeof value === "object" && "unit" in value ? value.unit : (row.weightUnit ?? "POUNDS");
        row.weight = lb === null ? null : Number((lb / (TO_LB[unit] ?? 1)).toFixed(4));
        row.weightUnit = lb === null ? row.weightUnit : unit;
      } else if (item.field === "cost") {
        row.cost = typeof value === "number" ? value : null;
      } else {
        row.barcode = typeof value === "string" ? value : null;
      }
      updates.push(row);
    }
    await prisma.$transaction(
      updates.map((r) =>
        prisma.catalogVariant.update({
          where: { id: r.id },
          data: { weight: r.weight, weightUnit: r.weightUnit, cost: r.cost, barcode: r.barcode },
        }),
      ),
    );
  }

  // Fixed differences drop out of the comparison; an undo needs a new comparison.
  if (comparisonId && !undo) {
    const byField = new Map<string, string[]>();
    for (const { item } of done) {
      byField.set(item.field, [...(byField.get(item.field) ?? []), item.variantId]);
    }
    await prisma.$transaction(
      [...byField].map(([field, variantIds]) =>
        prisma.wmsMismatch.deleteMany({
          where: {
            comparisonId,
            code: `${field}_mismatch`,
            variantId: { in: variantIds },
          },
        }),
      ),
    );
    const left = await prisma.wmsMismatch.count({ where: { comparisonId } });
    await prisma.wmsComparison.update({ where: { id: comparisonId }, data: { mismatchCount: left } });
  }
}

/** The shop's active batch (applying or undoing), if any. */
export const activeFix = (shop: string) =>
  prisma.fixBatch.findFirst({
    where: { shop, status: { in: ["applying", "undoing"] } },
    // Newest first, so undoing several fixes of one value ends at the oldest value.
    orderBy: { createdAt: "desc" },
  });

/**
 * History is kept for UNDO_DAYS: older fixes (no longer undoable), scheduled
 * run logs and comparisons are deleted, except each system's latest comparison.
 */
export async function pruneHistory(shop: string) {
  const cutoff = new Date(Date.now() - UNDO_DAYS * 86_400_000);
  const old = await prisma.fixBatch.findMany({
    where: { shop, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  const latest = await prisma.wmsComparison.findMany({
    where: { shop },
    orderBy: { startedAt: "desc" },
    distinct: ["provider"],
    select: { id: true },
  });
  const ids = old.map((b) => b.id);
  await prisma.$transaction([
    prisma.fixItem.deleteMany({ where: { batchId: { in: ids } } }),
    prisma.fixBatch.deleteMany({ where: { id: { in: ids } } }),
    prisma.syncRun.deleteMany({ where: { shop, startedAt: { lt: cutoff } } }),
  ]);
  const oldComparisons = await prisma.wmsComparison.findMany({
    where: { shop, startedAt: { lt: cutoff }, id: { notIn: latest.map((c) => c.id) } },
    select: { id: true },
  });
  const cids = oldComparisons.map((c) => c.id);
  if (cids.length) {
    await prisma.$transaction([
      prisma.wmsMismatch.deleteMany({ where: { comparisonId: { in: cids } } }),
      prisma.wmsFound.deleteMany({ where: { comparisonId: { in: cids } } }),
      prisma.wmsComparison.deleteMany({ where: { id: { in: cids } } }),
    ]);
  }
}

/** Recent batches for one warehouse system, after pruning expired history. */
export async function recentFixes(shop: string, provider: string) {
  await pruneHistory(shop);
  return prisma.fixBatch.findMany({
    where: { shop, provider },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}

/** Items of a batch that failed or were kept, to show why. */
export const problemItems = (batchId: string) =>
  prisma.fixItem.findMany({
    where: { batchId, status: { in: ["failed", "kept", "undo_failed"] } },
    take: 50,
  });

type Batch = Awaited<ReturnType<typeof prisma.fixBatch.findMany>>[number];

/** Batches as pages show them, with how many changes can still be undone. */
export async function batchRows(batches: Batch[]) {
  const ids = batches.map((b) => b.id);
  const still = ids.length
    ? await prisma.fixItem.groupBy({
        by: ["batchId"],
        where: { batchId: { in: ids }, status: "applied" },
        _count: true,
      })
    : [];
  const cutoff = Date.now() - UNDO_DAYS * 86_400_000;
  return batches.map((b) => {
    const undoable = still.find((g) => g.batchId === b.id)?._count ?? 0;
    return {
      id: b.id,
      provider: b.provider,
      comparisonId: b.comparisonId,
      source: b.source,
      status: b.status,
      total: b.total,
      applied: b.applied,
      failed: b.failed,
      reverted: b.reverted,
      kept: b.kept,
      error: b.error,
      createdAt: b.createdAt.toISOString(),
      undoable: (b.status === "done" || b.status === "failed") && b.createdAt.getTime() > cutoff ? undoable : 0,
    };
  });
}
