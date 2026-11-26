// Asks Shopify to show its App Store review modal after a merchant finishes
// something successfully (a fix, or a rescan that isn't the shop's first).
// Never on first open, never from a button, and never in a way that blocks the
// page: Shopify decides whether the modal shows, and any refusal or error is
// only logged to the console.

/** Shopify shows the modal at most once per 60 days (and three times a year). */
export const REVIEW_PROMPT_DAYS = 60;

// Refusals that mean Shopify won't show the modal for a while either, so the
// attempt is recorded and not repeated for 60 days. Others (mobile app, just
// installed, a modal already open) say nothing about later, so it may ask again.
const RECORDED_REFUSALS = new Set([
  "already-reviewed",
  "cooldown-period",
  "annual-limit-reached",
  "merchant-ineligible",
  "cancelled",
]);

/** Whether a shop last asked at `last` may be asked again at `now`. */
export const reviewPromptDueAt = (last: Date | null | undefined, now: Date) =>
  !last || now.getTime() - last.getTime() >= REVIEW_PROMPT_DAYS * 86_400_000;

/** Time between the success showing and the modal, so the result is seen first. */
export const REVIEW_PROMPT_DELAY_MS = 1500;

let asked = false;

/** Lets tests start a fresh "page load". */
export const resetReviewPrompt = () => {
  asked = false;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks for a review at most once per page load; never throws. */
export async function requestReview(reason: string) {
  if (asked || typeof shopify === "undefined") return;
  asked = true;
  try {
    const status = await fetch("/app/review-prompt");
    const { due } = status.ok ? ((await status.json()) as { due: boolean }) : { due: false };
    if (!due) return;
    await sleep(REVIEW_PROMPT_DELAY_MS);
    const result = await shopify.reviews.request();
    if (!result.success) console.info(`[review] not shown after ${reason}: ${result.code}`);
    if (result.success || RECORDED_REFUSALS.has(result.code)) {
      await fetch("/app/review-prompt", { method: "POST" });
    }
  } catch (error) {
    console.info(`[review] request failed after ${reason}:`, error);
  }
}
