import assert from "node:assert/strict";
import test from "node:test";
import { splitCents } from "../src/split.js";

test("an even bill splits evenly", () => {
  assert.deepEqual(splitCents(100, 4), [25, 25, 25, 25]);
});
