import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatGptUsage, windowLabel } from "../src/chatgpt.ts";

/** Captured live from chatgpt.com/backend-api/wham/usage (credentials stripped). */
const LIVE_CHATGPT = {
  user_id: "user-c6x0Xik5B6bzG9mGkFHZplzh",
  account_id: "60b20fe8-74cb-4c5d-8c20-33fb6e43109f",
  email: "someone@example.com",
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 5,
      limit_window_seconds: 604800,
      reset_after_seconds: 592745,
      reset_at: 1790519772,
    },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  spend_control: { reached: false, individual_limit: null },
};

test("parses the live ChatGPT Pro payload", () => {
  const usage = parseChatGptUsage(LIVE_CHATGPT);
  assert.equal(usage.id, "chatgpt-pro");
  assert.equal(usage.plan, "pro");
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].label, "Weekly");
  assert.equal(usage.windows[0].percent, 5);
  assert.equal(usage.windows[0].resetsAt, new Date(1790519772 * 1000).toISOString());
  assert.equal(usage.windows[0].secondsUntilReset, 592745);
  assert.equal(usage.note, null);
});

test("keeps a reported secondary window", () => {
  const usage = parseChatGptUsage({
    ...LIVE_CHATGPT,
    rate_limit: {
      ...LIVE_CHATGPT.rate_limit,
      secondary_window: {
        used_percent: 42,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: 1790000000,
      },
    },
  });
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[1].label, "5h");
  assert.equal(usage.windows[1].percent, 42);
});

test("flags a reached limit instead of silently showing a number", () => {
  const usage = parseChatGptUsage({
    ...LIVE_CHATGPT,
    rate_limit: { ...LIVE_CHATGPT.rate_limit, limit_reached: true },
  });
  assert.equal(usage.note, "Limit reached");
});

test("missing windows are reported, not invented", () => {
  const usage = parseChatGptUsage({ plan_type: "pro", rate_limit: null });
  assert.equal(usage.windows.length, 0);
  assert.equal(usage.note, "No rate-limit windows reported");
});

test("clamps out-of-range percentages", () => {
  const usage = parseChatGptUsage({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 137, limit_window_seconds: 604800, reset_after_seconds: 1 },
    },
  });
  assert.equal(usage.windows[0].percent, 100);
});

test("windowLabel maps common windows", () => {
  assert.equal(windowLabel(604800), "Weekly");
  assert.equal(windowLabel(18000), "5h");
  assert.equal(windowLabel(900), "15m");
  assert.equal(windowLabel(0), "Limit");
  assert.equal(windowLabel(undefined), "Limit");
});

test("rejects a non-object body", () => {
  assert.throws(() => parseChatGptUsage(null), /not an object/);
});
