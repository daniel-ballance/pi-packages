import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSuperGrokBilling } from "../src/supergrok.ts";

/**
 * Captured live from cli-chat-proxy.grok.com/v1/billing?format=credits.
 * Note the ABSENCE of creditUsagePercent: proto3 JSON omits zero-valued
 * fields, so "missing" must not be read as "0%".
 */
const LIVE_SUPERGROK = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-09-19T19:32:37.521788+00:00",
      end: "2026-09-26T19:32:37.521788+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-09-19T19:32:37.521788+00:00",
    billingPeriodEnd: "2026-09-26T19:32:37.521788+00:00",
  },
};

/** Shape with an explicit percentage (observed once usage is non-zero). */
const WITH_PERCENT = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-17T17:33:48.278812+00:00",
      end: "2026-08-24T17:33:48.278812+00:00",
    },
    creditUsagePercent: 63.4,
    productUsage: [{ product: "GrokBuild", usagePercent: 63.4 }],
    prepaidBalance: { val: 1250 },
  },
  subscription_tier: "supergrok",
};

test("parses the live payload and marks the percent as unreported", () => {
  const usage = parseSuperGrokBilling(LIVE_SUPERGROK);
  assert.equal(usage.id, "supergrok");
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].label, "Weekly");
  assert.equal(usage.windows[0].percent, null, "absent must not become 0");
  assert.equal(usage.windows[0].resetsAt, "2026-09-26T19:32:37.521Z");
  assert.equal(usage.note, "Usage percent not reported");
});

test("uses creditUsagePercent when present", () => {
  const usage = parseSuperGrokBilling(WITH_PERCENT, Date.parse("2026-08-20T00:00:00Z"));
  assert.equal(usage.plan, "supergrok");
  assert.equal(usage.windows[0].percent, 63.4);
  assert.equal(usage.note, null);
  assert.equal(usage.windows[0].secondsUntilReset, Math.round(
    (Date.parse("2026-08-24T17:33:48.000Z") - Date.parse("2026-08-20T00:00:00Z")) / 1000,
  ));
});

test("falls back to used/monthlyLimit for the monthly view", () => {
  const usage = parseSuperGrokBilling({
    config: {
      monthlyLimit: { val: 20000 },
      used: { val: 5000 },
      billingPeriodEnd: "2026-10-01T00:00:00+00:00",
    },
  });
  assert.equal(usage.windows[0].percent, 25);
  assert.equal(usage.note, null);
});

test("tolerates string cent values", () => {
  const usage = parseSuperGrokBilling({
    config: { monthlyLimit: { val: "4" }, used: { val: "1" } },
  });
  assert.equal(usage.windows[0]?.percent ?? null, 25);
});

test("a zero limit is not divided by", () => {
  const usage = parseSuperGrokBilling({
    config: { monthlyLimit: { val: 0 }, used: { val: 0 } },
  });
  assert.equal(usage.windows.length, 0);
  assert.equal(usage.note, "Usage percent not reported");
});

test("rejects a payload with no config", () => {
  assert.throws(() => parseSuperGrokBilling({}), /no config/);
});
