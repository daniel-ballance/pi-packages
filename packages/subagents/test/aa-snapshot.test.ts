import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error Intentional dependency-free JavaScript CLI import; no declaration file is shipped.
import { retrieveSnapshot } from "../skills/subagents/scripts/aa-snapshot.mjs";

const directories: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "aa-snapshot-test-")); directories.push(dir); return dir; };
after(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });
const row = (id: string, slug = id) => ({ id, slug, name: `Model ${id}`, evaluations: { artificial_analysis_intelligence_index: null } });
function payload(page: number, rows: unknown[], options: Record<string, unknown> = {}) {
  return JSON.stringify({ tier: "free", intelligence_index_version: 4.3,
    pagination: { page, page_size: 2, total_pages: 2, has_more: page < 2, ...options }, data: rows });
}
function response(body: string, status = 200) {
  return new Response(body, { status });
}
const fixedClock = () => "2026-02-03T04:05:06.000Z";

test("retrieves all pages, preserving raw bytes and producing private envelope/manifest", async () => {
  const out = join(scratch(), "snapshot");
  const bodies = [payload(1, [row("a"), row("b")]), payload(2, [row("c")])];
  const calls: string[] = [];
  await retrieveSnapshot({ out, apiKey: "secret-test-key", clock: fixedClock, methodologyVersion: "v4.3.2",
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "secret-test-key");
      return response(bodies[calls.length - 1]);
    } });
  assert.equal(calls.length, 2);
  const models = JSON.parse(readFileSync(join(out, "models.json"), "utf8"));
  assert.deepEqual(models.data.map((x: { id: string }) => x.id), ["a", "b", "c"]);
  assert.equal(models.methodologyVersion, "v4.3.2");
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.pages[0].sha256.length, 64);
  assert.equal(readFileSync(join(out, "page-001.json"), "utf8"), bodies[0]);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  for (const file of readdirSync(out)) assert.equal(statSync(join(out, file)).mode & 0o777, 0o600);
});

test("missing auth does not create output", async () => {
  const out = join(scratch(), "missing");
  await assert.rejects(retrieveSnapshot({ out, apiKey: "" }), /missing API key/);
  assert.throws(() => readFileSync(out));
});

test("HTTP errors and redirects are generic and never retried or logged", async () => {
  const out = join(scratch(), "failure");
  let count = 0;
  await assert.rejects(retrieveSnapshot({ out, apiKey: "do-not-print", fetchImpl: async () => { count++; return response("private response body", 429); } }), /snapshot failed/);
  assert.equal(count, 1);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.pages[0].status, "error");
  assert.doesNotMatch(JSON.stringify(manifest), /do-not-print|private response body/);
  const redirect = join(scratch(), "redirect");
  await assert.rejects(retrieveSnapshot({ out: redirect, apiKey: "secret", fetchImpl: async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, "error"); throw new TypeError("secret header and network details");
  } }), /snapshot failed/);
  assert.doesNotMatch(readFileSync(join(redirect, "manifest.json"), "utf8"), /secret header|network details/);
});

test("rejects pagination/version/identity inconsistencies and retains completed page", async (t) => {
  const cases = [
    [payload(1, [row("a"), row("b")]), payload(2, [row("c")], { page: 1 })],
    [payload(1, [row("a"), row("b")]), JSON.stringify({ ...JSON.parse(payload(2, [row("c")])), intelligence_index_version: 5 })],
    [payload(1, [row("a"), row("b")]), payload(2, [row("a")])],
    [payload(1, [row("a"), row("b")]), payload(2, [])],
  ];
  for (const [index, bodies] of cases.entries()) {
    await t.test(`case ${index}`, async () => {
      const out = join(scratch(), "bad"); let call = 0;
      await assert.rejects(retrieveSnapshot({ out, apiKey: "x", fetchImpl: async () => response(bodies[call++]) }), /snapshot failed/);
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      assert.equal(manifest.complete, false);
      assert.ok(readFileSync(join(out, "page-001.json")));
    });
  }
});

test("Free route accepts higher-tier keys but rejects tier changes during pagination", async () => {
  for (const tier of ["pro", "commercial"]) {
    let page = 0;
    const out = join(scratch(), tier);
    await retrieveSnapshot({ out, apiKey: "x", fetchImpl: async () => response(JSON.stringify({
      ...JSON.parse(payload(++page, page === 1 ? [row("a"), row("b")] : [row("c")])), tier,
    })) });
    assert.equal(JSON.parse(readFileSync(join(out, "models.json"), "utf8")).tier, tier);
  }
  const out = join(scratch(), "changed"); let page = 0;
  await assert.rejects(retrieveSnapshot({ out, apiKey: "x", fetchImpl: async () => response(JSON.stringify({
    ...JSON.parse(payload(++page, page === 1 ? [row("a"), row("b")] : [row("c")])), tier: page === 1 ? "free" : "pro",
  })) }));
});

test("malformed schemas, duplicate slugs, patch mismatch and invalid page counts fail closed", async () => {
  const valid = JSON.parse(payload(1, [row("a"), row("b")]));
  const mutations = [
    (p: any) => { p.pagination.total_pages = 101; },
    (p: any) => { p.pagination.has_more = false; },
    (p: any) => { p.pagination.page_size = 3; },
    (p: any) => { p.intelligence_index_version = "4.3"; },
    (p: any) => { p.intelligence_index_version = 4.2; },
    (p: any) => { p.data[1].slug = p.data[0].slug; },
    (p: any) => { delete p.data[0].name; },
  ];
  for (const mutate of mutations) {
    const p = structuredClone(valid); mutate(p);
    await assert.rejects(retrieveSnapshot({ out: join(scratch(), "bad"), apiKey: "x", methodologyVersion: "v4.3.2", fetchImpl: async () => response(JSON.stringify(p)) }));
  }
});

test("response bounds and rate-limit metadata do not expose error bodies", async () => {
  await assert.rejects(retrieveSnapshot({ out: join(scratch(), "large"), apiKey: "x", fetchImpl: async () => new Response("", { headers: { "content-length": String(9 * 1024 * 1024) } }) }));
  await assert.rejects(retrieveSnapshot({ out: join(scratch(), "stream-too-large"), apiKey: "x", fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)) }));
  const out = join(scratch(), "quota");
  await assert.rejects(retrieveSnapshot({ out, apiKey: "x", fetchImpl: async () => new Response("SECRET", { status: 429, headers: { "retry-after": "123", "x-ratelimit-reset": "1000" } }) }));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.pages[0].httpStatus, 429);
  assert.equal(manifest.pages[0].rateLimit["retry-after"], "123");
  assert.doesNotMatch(JSON.stringify(manifest), /SECRET/);
  assert.ok(!readdirSync(out).includes("page-001.json"));
});

test("refuses reused output directories", async () => {
  const out = scratch();
  await assert.rejects(retrieveSnapshot({ out, apiKey: "x", fetchImpl: async () => response("") }));
});
