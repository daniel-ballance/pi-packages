import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { splitCents } = await import(pathToFileURL(resolve("src/split.js")));
for (const [total, people] of [[1000, 3], [0, 4], [1, 3], [101, 4], [997, 7], [12, 5], [100, 4], [19, 1]]) {
  const shares = splitCents(total, people);
  assert.ok(Array.isArray(shares));
  assert.equal(shares.length, people);
  for (const share of shares) assert.ok(Number.isSafeInteger(share) && share >= 0);
  assert.equal(shares.reduce((a, b) => a + b, 0), total);
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
}
