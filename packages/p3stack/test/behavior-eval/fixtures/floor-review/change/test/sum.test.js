import assert from "node:assert/strict";
import test from "node:test";
import { sum, sumAll } from "../src/sum.js";

test("sum adds two numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("sumAll adds every value", () => {
  assert.equal(sumAll([1, 2, 3]), 6);
});

test.{{SKIP}}("sumAll of an empty list is zero", () => {
  assert.equal(sumAll([]), 0);
});
