import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "../extra/skills/poteto-mode/scripts/bun-test.ts";

test("toBeUndefined accepts only undefined", () => {
  expect(undefined).toBeUndefined();
  for (const value of [null, false, 0, "", {}, []]) {
    assert.throws(() => expect(value).toBeUndefined(), assert.AssertionError);
  }
});
