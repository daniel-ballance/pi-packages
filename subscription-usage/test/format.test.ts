import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCountdown, formatFooter, formatProviderLine, formatWindow } from "../src/format.ts";
import type { ProviderUsage } from "../src/types.ts";

function provider(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    id: "chatgpt-pro",
    name: "ChatGPT Pro",
    glyph: "GPT",
    plan: "pro",
    windows: [],
    note: null,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

test("formatCountdown", () => {
  assert.equal(formatCountdown(604800), "7d 0h");
  assert.equal(formatCountdown(592745), "6d 20h");
  assert.equal(formatCountdown(4500), "1h 15m");
  assert.equal(formatCountdown(300), "5m");
  assert.equal(formatCountdown(20), "now");
  assert.equal(formatCountdown(null), "unknown");
  assert.equal(formatCountdown(-5), "now");
});

test("formatWindow", () => {
  assert.equal(
    formatWindow({ label: "Weekly", percent: 5, secondsUntilReset: 592745 }),
    "5% weekly · resets 6d 20h",
  );
  assert.equal(formatWindow({ label: "Weekly", percent: null, secondsUntilReset: null }), "— weekly");
});

test("formatFooter prefers the most-used window", () => {
  const footer = formatFooter([
    provider({
      windows: [
        { label: "Weekly", percent: 5, resetsAt: null, secondsUntilReset: null },
        { label: "5h", percent: 40, resetsAt: null, secondsUntilReset: null },
      ],
    }),
    provider({
      id: "supergrok",
      name: "SuperGrok",
      glyph: "SG",
      windows: [{ label: "Weekly", percent: null, resetsAt: null, secondsUntilReset: null }],
    }),
  ]);
  assert.equal(footer, "GPT 40% · SG —");
});

test("formatProviderLine carries the note", () => {
  const line = formatProviderLine(
    provider({
      windows: [{ label: "Weekly", percent: 5, resetsAt: null, secondsUntilReset: 592745 }],
      note: "Limit reached",
    }),
  );
  assert.match(line, /ChatGPT Pro: 5% weekly · resets 6d 20h {2}\(Limit reached\)/);
});

test("formatProviderLine with no windows", () => {
  assert.match(formatProviderLine(provider({ note: "no windows" })), /no windows/);
});
