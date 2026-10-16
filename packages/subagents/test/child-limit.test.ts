import assert from "node:assert/strict";
import { test } from "node:test";
import { allows, capacityOf, limitLabel, OMITTED_CHILD_LIMIT, parseChildLimit, reportedLimit } from "../extensions/subagents/src/child-limit.js";

const INVALID = /maxChildren must be a positive integer, 0 to disable spawning, or -1 for no limit/;

const parsed: { name: string; value: unknown; limit?: { kind: string; max?: number } }[] = [
  { name: "omitted", value: undefined, limit: { kind: "capped", max: 4 } },
  { name: "0", value: 0, limit: { kind: "off" } },
  { name: "1", value: 1, limit: { kind: "capped", max: 1 } },
  { name: "65", value: 65, limit: { kind: "capped", max: 65 } },
  { name: "large safe integer", value: Number.MAX_SAFE_INTEGER, limit: { kind: "capped", max: Number.MAX_SAFE_INTEGER } },
  { name: "-1", value: -1, limit: { kind: "unlimited" } },
  { name: "-2", value: -2 },
  { name: "1.5", value: 1.5 },
  { name: "NaN", value: NaN },
  { name: "Infinity", value: Infinity },
  { name: "2 ** 53", value: 2 ** 53 },
  { name: '"4"', value: "4" },
  { name: "null", value: null },
];

for (const entry of parsed) {
  test(`parseChildLimit ${entry.name}`, () => {
    if (!entry.limit) {
      assert.throws(() => parseChildLimit(entry.value), INVALID);
      return;
    }
    assert.deepEqual(parseChildLimit(entry.value), entry.limit);
  });
}

test("an omitted field is the capped default of 4, not the built-in 6", () => {
  assert.deepEqual(OMITTED_CHILD_LIMIT, { kind: "capped", max: 4 });
  assert.equal(parseChildLimit(undefined), OMITTED_CHILD_LIMIT);
});

test("admission and the reported limit follow the kind, never the wire numbers", () => {
  const off = parseChildLimit(0);
  const one = parseChildLimit(1);
  const sixtyFive = parseChildLimit(65);
  const open = parseChildLimit(-1);
  assert.equal(allows(off, 0), false);
  assert.equal(allows(off, 1), false);
  assert.equal(allows(one, 1), true);
  assert.equal(allows(one, 2), false);
  assert.equal(allows(sixtyFive, 65), true);
  assert.equal(allows(sixtyFive, 66), false);
  assert.equal(allows(open, 0), true);
  assert.equal(allows(open, 100), true);
  assert.equal(reportedLimit(off), 0);
  assert.equal(reportedLimit(one), 1);
  assert.equal(reportedLimit(sixtyFive), 65);
  assert.equal(reportedLimit(open), "unlimited");
  assert.deepEqual(capacityOf(off, 2, 3), { limit: 0, live: 2, reserved: 3, available: 0 });
  assert.deepEqual(capacityOf(parseChildLimit(4), 1, 1), { limit: 4, live: 1, reserved: 1, available: 2 });
  assert.deepEqual(capacityOf(parseChildLimit(4), 3, 2), { limit: 4, live: 3, reserved: 2, available: 0 });
  assert.deepEqual(capacityOf(open, 70, 4), { limit: "unlimited", live: 70, reserved: 4, available: Number.MAX_SAFE_INTEGER });
});

test("unlimited capacity stays finite and never reports -1 through JSON", () => {
  const round = JSON.parse(JSON.stringify(capacityOf(parseChildLimit(-1), 70, 4)));
  assert.equal(round.limit, "unlimited");
  assert.equal(Number.isFinite(round.available), true);
  assert.equal(round.available, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.stringify(round).includes("-1"), false);
});

test("available is 0 exactly when one more child is refused", () => {
  const limits = [parseChildLimit(0), parseChildLimit(1), parseChildLimit(4), parseChildLimit(Number.MAX_SAFE_INTEGER), parseChildLimit(-1)];
  const occupancies = [[0, 0], [1, 0], [0, 1], [3, 1], [4, 0], [2, 2], [100, 0]];
  for (const limit of limits) for (const [live, reserved] of occupancies) {
    const capacity = capacityOf(limit, live, reserved);
    const refused = !allows(limit, live + reserved + 1);
    assert.equal(capacity.available === 0, refused, JSON.stringify({ limit, live, reserved, capacity }));
    assert.equal(Number.isFinite(capacity.available), true);
    assert.notEqual(capacity.limit, -1);
    assert.equal(capacity.limit, reportedLimit(limit));
  }
});

test("every reported limit has a label, and a value the catalog cannot produce does not", () => {
  for (const value of [undefined, 0, 1, 65, Number.MAX_SAFE_INTEGER, -1]) {
    const reported = reportedLimit(parseChildLimit(value));
    assert.notEqual(limitLabel(reported), undefined, String(value));
    assert.notEqual(reported, -1);
  }
  assert.equal(limitLabel("unlimited"), "no child limit");
  assert.equal(limitLabel(0), "max 0 children");
  assert.equal(limitLabel(6), "max 6 children");
  assert.equal(limitLabel(-1), undefined);
  assert.equal(limitLabel(1.5), undefined);
  assert.equal(limitLabel("4"), undefined);
  assert.equal(limitLabel(null), undefined);
});
