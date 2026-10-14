import assert from "node:assert/strict";
import { test } from "node:test";
import { readUsage, renderMeter, renderReport, resetTime, type ReportDetails } from "../extensions/claude-subscription/src/usage.js";

// The plan fields captured from probe1-handshake.out.json's `usage` response, 2026-10-13.
const captured = {
  subscription_type: "max", rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 4, resets_at: "2026-10-14T01:40:00.261490+00:00" },
    seven_day: { utilization: 1, resets_at: "2026-10-20T23:00:00.261512+00:00" },
    seven_day_opus: null, seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    limits: [
      { kind: "session", group: "session", percent: 4, severity: "normal", resets_at: "2026-10-14T01:40:00.261490+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 1, severity: "normal", resets_at: "2026-10-20T23:00:00.261512+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 1, severity: "normal", resets_at: "2026-10-20T23:00:00.261669+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
    model_scoped: [{ display_name: "Fable", utilization: 1, resets_at: "2026-10-20T23:00:00.261669+00:00" }],
  },
};

const event = {
  status: "allowed", resetsAt: 1791942000, rateLimitType: "five_hour", overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled", isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791942000 }, seven_day: { utilization: 0.01, resetsAt: 1792537200 } },
};

const details: ReportDetails = {
  account: { subscriptionType: "Claude Max", email: "user@example.invalid", organization: "Personal" },
  fastMode: { state: "off", reason: "extra_usage_disabled" }, spend: { costUsd: 0.012345, turns: 1 },
  openSessions: 2, configProblems: [], configPath: "/agent/claude-subscription.json",
};
const iso = (time: number): string => new Date(time).toISOString();

test("the captured plan report keeps every server row and uses percentage units", () => {
  const usage = readUsage(captured, event);
  assert.equal(usage.source, "report");
  assert.equal(usage.subscription, "max");
  assert.equal(usage.extraUsage, false);
  assert.deepEqual(usage.limits.map(row => [row.kind, row.group, row.label, row.percent]), [
    ["session", "session", "5-hour", 4], ["weekly_all", "weekly", "Weekly (all models)", 1],
    ["weekly_scoped", "weekly", "Weekly · Fable", 1],
  ]);
  assert.equal(usage.limits[0].resetsAt, Date.parse(captured.rate_limits.five_hour.resets_at));
  assert.equal(renderMeter(usage, "always"), "5h 4% · wk 1%");
  const report = renderReport(usage, details, iso);
  assert.match(report, /^Claude Max · user@example.invalid · Personal/);
  assert.match(report, /5-hour: 4% used · resets 2026-10-14T01:40:00.261Z/);
  assert.match(report, /Weekly · Fable: 1% used · resets 2026-10-20T23:00:00.261Z/);
  assert.match(report, /Extra usage: off/);
  assert.match(report, /Fast mode: off \(unavailable: extra usage is off\)/);
  assert.match(report, /\$0.0123 estimate at API list prices · 1 turn · not a bill/);
  assert.match(report, /2 open Claude Code sessions/);
  assert.match(renderReport(usage, { ...details, fastMode: { state: "off", reason: "sdk_opt_in_required" } }),
    /Fast mode: off \(unavailable: not enabled for this connection\)/);
});

test("turn events read unified windows as fractions and epoch seconds", () => {
  const usage = readUsage(undefined, event);
  assert.equal(usage.source, "event");
  assert.deepEqual(usage.limits.map(row => row.percent), [8, 1]);
  assert.equal(usage.limits[0].resetsAt, 1791942000000);
  assert.equal(renderMeter(usage, "always"), "5h 8% · wk 1%");
  assert.equal(renderMeter(usage, "attention"), undefined);
  assert.match(renderReport(usage, details), /Limits from the last turn; full plan report unavailable/);
  assert.match(renderReport(usage, details), /Extra usage: off \(disabled by your organization\)/);
});

test("attention starts at eighty percent for events and reached limits say so", () => {
  const warning = readUsage(undefined, { ...event, unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: 1791942000 } } });
  assert.equal(renderMeter(warning, "attention", iso), "5h 80% near limit · resets 2026-10-14T01:40:00.000Z");
  const rejected = readUsage(undefined, { ...event, status: "rejected" });
  assert.match(renderMeter(rejected, "always", iso) ?? "", /^5h 8% limit reached · resets /);
  assert.equal(renderMeter(rejected, "off"), undefined);
  assert.equal(renderMeter(readUsage(undefined, { status: "rejected" }), "attention"), "Claude plan limit reached");
  assert.match(renderMeter(readUsage(undefined, { status: "allowed_warning", rateLimitType: "five_hour" }), "attention") ?? "", /near limit/);
});

test("server severity determines attention without grading its rows ourselves", () => {
  const normal = readUsage({ rate_limits: { limits: [{ kind: "session", percent: 95, severity: "normal" }] } });
  assert.equal(renderMeter(normal, "attention"), undefined);
  const warning = readUsage({ rate_limits: { limits: [{ kind: "weekly_scoped", percent: 40, severity: "warning", scope: { model: { display_name: "Fable" } } }] } });
  assert.equal(renderMeter(warning, "attention"), "wk Fable 40% near limit");
  const reached = readUsage({ rate_limits: { limits: [{ kind: "session", percent: 100 }] } });
  assert.equal(renderMeter(reached, "attention"), "5h 100% limit reached");
  const labeled = readUsage({ rate_limits: { limits: [{ kind: "session", label: "Current session", percent: 5 }] } });
  assert.match(renderReport(labeled, details), /Current session: 5% used/);
});

test("unknown server rows keep their labels, scopes and order even with missing fields", () => {
  const usage = readUsage({ rate_limits: { limits: [
    { kind: "daily_surface", group: "daily", display_name: "Design allowance", percent: 12.5, resets_at: "bad", scope: { model: { display_name: "Next" }, surface: { display_name: "Design" } } },
    { kind: "future_limit", group: "new", label: "Weekend bonus", percent: null },
    {}, null, false,
  ] } });
  assert.deepEqual(usage.limits.map(row => row.label), ["Design allowance · Next · Design", "Weekend bonus", "Plan limit"]);
  const report = renderReport(usage, details);
  assert.match(report, /Design allowance · Next · Design: 13% used · reset unknown/);
  assert.match(report, /Weekend bonus: usage unknown · reset unknown/);
  assert.match(report, /Plan limit: usage unknown/);
});

test("older reports without limits rows keep legacy and model scoped windows", () => {
  const { limits: _limits, ...rates } = captured.rate_limits;
  const usage = readUsage({ rate_limits: rates });
  assert.deepEqual(usage.limits.map(row => [row.label, row.percent]), [["5-hour", 4], ["Weekly (all models)", 1], ["Weekly · Fable", 1]]);
});

test("missing report windows fall back to events while an explicit empty list stays empty", () => {
  for (const report of [undefined, null, {}, { rate_limits: null }, { rate_limits: { limits: null } }]) {
    assert.equal(renderMeter(readUsage(report, event), "always"), "5h 8% · wk 1%");
  }
  const empty = readUsage({ rate_limits: { limits: [] } }, event);
  assert.equal(empty.limits.length, 0);
  assert.match(renderReport(empty, details), /No plan limits reported/);
});

test("degraded payloads never throw or print invalid percentages and dates", () => {
  for (const value of [undefined, null, true, "unknown", 1, [], { rate_limits: 1 },
    { rate_limits: { limits: [{ percent: NaN, resets_at: {} }, { percent: Infinity, resets_at: "invalid" }], model_scoped: [null] } },
    { unifiedWindows: { five_hour: null, seven_day: { utilization: -1, resetsAt: Infinity } } },
    { unifiedWindows: { constructor: { utilization: 1e308 } } },
    { rate_limits: { constructor: { utilization: 8 } } },
  ]) {
    const report = renderReport(readUsage(value, value), { ...details, account: undefined, fastMode: undefined });
    assert.doesNotMatch(report, /NaN|Infinity|Invalid Date/);
  }
  assert.equal(renderMeter(readUsage(undefined), "always"), "Claude usage unavailable");
  assert.match(renderReport(readUsage(undefined), { ...details, account: undefined }), /Claude plan unknown\nPlan usage unavailable/);
  assert.ok(resetTime(1791942000000).length > 0);
});

test("the report shows configuration and account problems alongside available usage", () => {
  const report = renderReport(readUsage(undefined, event), {
    ...details, account: undefined, accountProblem: "not signed in", configProblems: ['unknown setting "meter"'],
    fastMode: { state: "unavailable", reason: "future_reason" },
  });
  assert.match(report, /Account: not signed in/);
  assert.match(report, /5-hour: 8% used/);
  assert.match(report, /Fast mode: unavailable \(future reason\)/);
  assert.match(report, /Configuration \(\/agent\/claude-subscription.json\):\n  unknown setting "meter"/);
});
