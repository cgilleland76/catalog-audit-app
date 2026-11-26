import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_PROMPT_DELAY_MS,
  requestReview,
  resetReviewPrompt,
  reviewPromptDueAt,
} from "../app/lib/review-prompt.ts";

type Result = { success: boolean; code: string; message: string };

let due = true;
let result: Result | Error = { success: true, code: "success", message: "Review modal shown successfully" };
let requested = 0;
let requestedAt = 0;
let recorded = 0;
let started = 0;
const logs: string[] = [];

beforeEach(() => {
  resetReviewPrompt();
  due = true;
  result = { success: true, code: "success", message: "Review modal shown successfully" };
  requested = requestedAt = recorded = 0;
  logs.length = 0;
  started = Date.now();
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") recorded++;
    return Response.json({ due });
  }) as typeof fetch;
  (globalThis as { shopify?: unknown }).shopify = {
    reviews: {
      request: async () => {
        requested++;
        requestedAt = Date.now();
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  console.info = (...args: unknown[]) => void logs.push(args.join(" "));
});

test("asks once per page load, after the delay, and records it", async () => {
  await requestReview("fix");
  await requestReview("rescan");
  assert.equal(requested, 1);
  assert.equal(recorded, 1);
  assert.ok(requestedAt - started >= REVIEW_PROMPT_DELAY_MS - 50, "waits so the result is seen first");
});

test("doesn't ask when the shop was asked in the last 60 days", async () => {
  due = false;
  await requestReview("fix");
  assert.equal(requested, 0);
  assert.equal(recorded, 0);
});

test("a cooldown or already-reviewed refusal is logged and recorded", async () => {
  for (const code of ["cooldown-period", "already-reviewed", "annual-limit-reached"]) {
    resetReviewPrompt();
    recorded = 0;
    result = { success: false, code, message: "" };
    await requestReview("fix");
    assert.equal(recorded, 1, code);
    assert.ok(logs.some((l) => l.includes(code)));
  }
});

test("a refusal that says nothing about later (mobile app) isn't recorded", async () => {
  result = { success: false, code: "mobile-app", message: "" };
  await requestReview("fix");
  assert.equal(requested, 1);
  assert.equal(recorded, 0);
});

test("an error never reaches the merchant", async () => {
  result = new Error("App Bridge unavailable");
  await assert.doesNotReject(requestReview("fix"));
  assert.equal(recorded, 0);
  assert.ok(logs.some((l) => l.includes("request failed")));
});

test("60-day rule", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  assert.equal(reviewPromptDueAt(null, now), true);
  assert.equal(reviewPromptDueAt(new Date("2026-10-01T12:00:00Z"), now), false);
  assert.equal(reviewPromptDueAt(new Date("2026-09-27T12:00:00Z"), now), true);
});
