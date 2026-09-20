import { test } from "node:test";
import assert from "node:assert/strict";
import { readCredentials } from "../src/auth.ts";

const FIXTURE = {
  "openai-codex": { type: "oauth", access: "  tok-chat  ", accountId: "acct-123", expires: 1 },
  xai: { type: "oauth", access: "tok-grok", expires: 2 },
  other: { type: "api_key", access: "nope" },
};

function loader(value: unknown) {
  return () => JSON.stringify(value);
}

test("reads both providers from Pi's auth store", () => {
  const creds = readCredentials({ path: "/fake", readFile: loader(FIXTURE) });
  assert.deepEqual(creds.chatgpt, { accessToken: "tok-chat", accountId: "acct-123" });
  assert.deepEqual(creds.supergrok, { accessToken: "tok-grok" });
});

test("skips chatgpt when accountId is missing", () => {
  const creds = readCredentials({
    path: "/fake",
    readFile: loader({ "openai-codex": { type: "oauth", access: "tok" } }),
  });
  assert.equal(creds.chatgpt, undefined);
});

test("skips non-oauth entries", () => {
  const creds = readCredentials({
    path: "/fake",
    readFile: loader({ xai: { type: "api_key", access: "sk-xai" } }),
  });
  assert.equal(creds.supergrok, undefined);
});

test("unreadable or malformed auth degrades to empty, never throws", () => {
  assert.deepEqual(readCredentials({ path: "/fake", readFile: () => "{not json" }), {});
  assert.deepEqual(
    readCredentials({
      path: "/fake",
      readFile: () => {
        throw new Error("ENOENT");
      },
    }),
    {},
  );
});
