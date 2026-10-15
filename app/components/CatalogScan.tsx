import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";

import type { ScanState } from "../lib/catalog";

type ScanResponse = { scan: ScanState | null };

const newest = (...scans: (ScanState | null | undefined)[]) =>
  scans.reduce<ScanState | null>(
    (best, s) => (s && (!best || s.startedAt > best.startedAt) ? s : best),
    null,
  );

/**
 * Tracks the shared catalog scan: polls while it runs and reloads the page's
 * data once a newer scan finishes.
 */
export function useCatalogScan(initial: ScanState | null, scannedAt: string | null) {
  const poll = useFetcher<ScanResponse>();
  const starter = useFetcher<ScanResponse>();
  const revalidator = useRevalidator();

  // Earlier arguments win ties: the latest poll knows more than the loader.
  const scan = newest(poll.data?.scan, starter.data?.scan, initial);
  const running = scan?.status === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (poll.state === "idle") poll.load("/app/scan");
    }, 3000);
    return () => clearInterval(timer);
  }, [running, poll]);

  const hasNewerRows =
    scan?.status === "done" &&
    scan.finishedAt !== null &&
    (scannedAt === null || scan.finishedAt > scannedAt);

  useEffect(() => {
    if (hasNewerRows && revalidator.state === "idle") revalidator.revalidate();
  }, [hasNewerRows, revalidator]);

  return {
    scan,
    running: running || starter.state !== "idle" || hasNewerRows,
    rescan: () => starter.submit({}, { method: "POST", action: "/app/scan" }),
  };
}

const elapsed = (since: string) => {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

/** Full-page placeholder shown until the first scan has finished. */
export function ScanProgress({
  scan,
  onRetry,
}: {
  scan: ScanState | null;
  onRetry: () => void;
}) {
  if (scan?.status === "failed") return <ScanFailed scan={scan} onRetry={onRetry} />;
  return (
    <s-section>
      <s-stack direction="block" gap="base" alignItems="center" padding="large">
        <s-spinner accessibilityLabel="Reading your catalog" size="large" />
        <s-heading>Reading your catalog…</s-heading>
        <s-text>
          {scan && scan.objectCount > 0
            ? `${scan.objectCount.toLocaleString()} variants read so far`
            : "Starting the export"}
          {scan ? ` · ${elapsed(scan.startedAt)}` : ""}
        </s-text>
        <s-text color="subdued">
          Shopify exports your catalog in the background. Most stores take
          under 2 minutes. This page updates on its own, and you can leave and
          come back.
        </s-text>
      </s-stack>
    </s-section>
  );
}

/** Banner shown above existing results while a rescan runs or after it fails. */
export function ScanBanner({
  scan,
  scannedAt,
  onRetry,
}: {
  scan: ScanState | null;
  scannedAt: string | null;
  onRetry: () => void;
}) {
  if (scan?.status === "failed") return <ScanFailed scan={scan} onRetry={onRetry} />;
  if (scan?.status !== "running") return null;
  return (
    <s-banner tone="info">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-spinner accessibilityLabel="Rescanning" size="base" />
        <s-text>
          Rescanning your catalog
          {scan.objectCount > 0
            ? ` — ${scan.objectCount.toLocaleString()} variants read so far`
            : ""}
          . Showing results from{" "}
          {scannedAt ? new Date(scannedAt).toLocaleString() : "the last scan"}{" "}
          until it finishes.
        </s-text>
      </s-stack>
    </s-banner>
  );
}

function ScanFailed({ scan, onRetry }: { scan: ScanState; onRetry: () => void }) {
  return (
    <s-banner tone="critical" heading="Catalog scan failed">
      <s-stack direction="block" gap="small">
        <s-text>{scan.error ?? "Something went wrong reading your catalog."}</s-text>
        <s-button onClick={onRetry}>Try again</s-button>
      </s-stack>
    </s-banner>
  );
}
