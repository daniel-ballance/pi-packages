import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reference = name => readFileSync(new URL(`../skills/p3stack-mode/references/${name}.md`, import.meta.url), "utf8");

test("a coordinator can distinguish concurrent runs and reconcile one attempt without redispatch", () => {
  const ledger = reference("execution-ledger");
  assert.match(ledger, /mktemp -d|randomUUID/);
  assert.match(ledger, /coordinator (?:alone|is the only writer)/i);
  const row = ledger.split("\n").find(line => /unit.*attempt/i.test(line)) ?? "";
  for (const field of ["child", "checkout", "branch", "base", "head", "state", "evidence", "pending gate"]) assert.ok(row.includes(field), field);
  assert.match(ledger, /recovery[^#]*(?:verify|check)[^#]*artifact/i);
  assert.match(ledger, /held/);
  assert.match(ledger, /still (?:refers|points)|no .*points at/i);
  assert.ok(ledger.includes("(../poteto-mode/references/host-capabilities.md)"));
});

test("the brief travels without the parent's files and keeps volatile details out of the ticket", () => {
  const brief = reference("brief-contract");
  assert.match(brief, /stand(?:s)? alone|self-contained/i);
  assert.match(brief, /T3 Code[^\n]*parent/i);
  assert.match(brief, /(?:ticket.*acceptance criteria|acceptance criteria.*ticket)/i);
  assert.match(brief, /grant/i);
  assert.doesNotMatch(brief, /Pass file pointers, not pasted history/);
});

test("report-only reviewers stop the fix loop per finding, not per run", () => {
  const stance = reference("review-stance");
  assert.match(stance, /report-only/i);
  assert.match(stance, /(?:two|2) fix rounds (?:for|per) (?:a |each )?finding/i);
  assert.match(stance, /park[^\n]*dispute|dispute[^\n]*park/i);
});
