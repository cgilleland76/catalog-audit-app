import { useNavigation } from "react-router";

/**
 * The query of a page load in progress to `pathname` (a filter, search or
 * "Show more" on the same page), or null when nothing is loading there.
 */
export function usePendingQuery(pathname: string) {
  const navigation = useNavigation();
  const next = navigation.location;
  return navigation.state === "loading" && next?.pathname === pathname
    ? new URLSearchParams(next.search)
    : null;
}

/** "Updating…" with a spinner, shown while the page's results reload. */
export function Updating() {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-spinner accessibilityLabel="Updating results" size="base" />
      <s-text color="subdued">Updating…</s-text>
    </s-stack>
  );
}

/** Dims results that are about to be replaced. */
export const dimmed = (on: boolean) =>
  ({ opacity: on ? 0.5 : 1, transition: "opacity 0.15s" }) as const;
