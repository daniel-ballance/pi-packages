// The part of Bun's test API that the upstream script tests use, on node:test.
// Hand-written for pistack (extra/); the upstream tests import it in place of "bun:test".
import assert from "node:assert/strict";
import { afterEach, describe, it, test } from "node:test";

export { afterEach, describe, it, test };

type Expected = string | RegExp | (abstract new (...args: never[]) => unknown);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Bun's toEqual ignores undefined properties and does not compare prototypes.
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Error) return { name: value.name, message: value.message, ...plainFields(value) };
  if (!isRecord(value) || value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) return value;
  return plainFields(value);
}

function plainFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, plain(entry)]));
}

const special = (value: unknown) => value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof Error;

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((entry, index) => matches(actual[index], entry));
  if (isRecord(expected) && !special(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, entry]) => matches(actual[key], entry));
  }
  try { assert.deepStrictEqual(plain(actual), plain(expected)); return true; } catch { return false; }
}

function checkError(error: unknown, expected?: Expected): void {
  if (expected === undefined) return;
  if (typeof expected === "function") { assert.ok(error instanceof expected, `expected ${expected.name}, got ${String(error)}`); return; }
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === "string") assert.ok(message.includes(expected), `expected an error containing ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
  else assert.match(message, expected);
}

function contains(actual: unknown, item: unknown): boolean {
  if (typeof actual === "string") return actual.includes(String(item));
  if (Array.isArray(actual)) return actual.includes(item);
  throw new TypeError("toContain expects a string or an array");
}

async function rejection(promise: unknown): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new assert.AssertionError({ message: "expected the promise to reject" });
}

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(plain(actual), plain(expected)),
    toContain: (item: unknown) => assert.ok(contains(actual, item), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`),
    toBeInstanceOf: (expected: abstract new (...args: never[]) => unknown) => assert.ok(actual instanceof expected, `expected an instance of ${expected.name}`),
    toBeNull: () => assert.strictEqual(actual, null),
    toEndWith: (suffix: string) => assert.ok(typeof actual === "string" && actual.endsWith(suffix), `expected ${JSON.stringify(actual)} to end with ${JSON.stringify(suffix)}`),
    toHaveLength: (length: number) => assert.strictEqual((actual as { length: number }).length, length),
    toMatchObject: (expected: object) => assert.ok(matches(actual, expected), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
    toThrow: (expected?: Expected) => {
      assert.equal(typeof actual, "function", "toThrow expects a function");
      let thrown = false;
      try { (actual as () => unknown)(); } catch (error) { thrown = true; checkError(error, expected); }
      assert.ok(thrown, "expected the function to throw");
    },
    not: {
      toContain: (item: unknown) => assert.ok(!contains(actual, item), `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`),
    },
    rejects: {
      toThrow: async (expected?: Expected) => checkError(await rejection(actual), expected),
      toBeInstanceOf: async (expected: abstract new (...args: never[]) => unknown) => checkError(await rejection(actual), expected),
    },
  };
}
