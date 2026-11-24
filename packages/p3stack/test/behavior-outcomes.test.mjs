import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grade, materialize, trace } from "./behavior-eval/run.mjs";

const { cases } = JSON.parse(readFileSync(new URL("./behavior-eval/cases.json", import.meta.url)));
const seen = (calls = [], final = "") => ({ calls, final });
function fixture(t, id) {
  const project = mkdtempSync(join(tmpdir(), "grade-behavior-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const before = materialize(id, project), row = cases.find(row => row.id === id);
  const checks = [...row.outcome, ...row.process];
  const check = (id, trace = seen()) => grade(checks.find(check => check.id === id), trace, project, before);
  return { check, put: (path, text) => writeFileSync(join(project, path), text), project };
}

const goodSplit = `export function splitCents(n,p) {
  const q = Math.floor(n/p);
  return Array.from({length:p}, (_,i) => q + (i >= p-n%p ? 1 : 0));
}`;
const exampleOnly = `export function splitCents(n,p) { return n===1000 && p===3 ? [333,333,334] : Array(p).fill(Math.floor(n/p)) }`;

test("the shipped split oracle accepts a valid remainder order, not an example-only patch or the original loss", t => {
  const { check, put, project } = fixture(t, "bug-red-first");
  const original = readFileSync(join(project, "src/split.js"));
  put("src/split.js", goodSplit);
  assert.equal(check("bug-fixed"), true);
  for (const broken of [exampleOnly, original, "export const splitCents = (n,p) => Array(p).fill(n/p)", "export const splitCents = n => [n]"]) {
    put("src/split.js", broken);
    assert.equal(check("bug-fixed"), false);
  }
});

test("the submitted suite must distinguish original and fixed source, not just mention 1000", t => {
  const { check, project, put } = fixture(t, "bug-red-first");
  put("src/split.js", goodSplit);
  const path = join(project, "test/split.test.js"), original = readFileSync(path, "utf8");
  writeFileSync(path, original + '\ntest("keeps all 11 cents", () => assert.equal(splitCents(11,3).reduce((a,b)=>a+b,0),11));');
  assert.equal(check("regression-test"), true);
  for (const inert of [original, original + "\n// 1000"]) {
    writeFileSync(path, inert);
    assert.equal(check("regression-test"), false);
  }
});

test("regression replay must not overwrite a source directory linked out of the submission", t => {
  const { check, project } = fixture(t, "bug-red-first");
  const other = mkdtempSync(join(tmpdir(), "linked-source-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(join(other, "split.js"), goodSplit);
  rmSync(join(project, "src"), { recursive: true });
  symlinkSync(other, join(project, "src"));
  assert.equal(check("regression-test"), false);
  assert.equal(readFileSync(join(other, "split.js"), "utf8"), goodSplit);
});

test("the review must identify the skipped empty-list test and preserve an already dirty fixture", t => {
  const { check, project, put } = fixture(t, "floor-review");
  const report = text => check("names-skipped-test", seen([], text));
  assert.equal(report('test/sum.test.js skips “sumAll of an empty list is zero”; sumAll([]) actually throws.'), true);
  assert.equal(report("No tests were skipped."), false);
  assert.equal(report("There is a skipped test in this repo."), false);
  assert.equal(report("No tests were skipped. sumAll([]) works."), false);
  assert.equal(report("The test for sumAll([]) is not skipped."), false);
  assert.equal(check("unchanged-tree"), true);
  put("notes.txt", "unrequested\n");
  assert.equal(check("unchanged-tree"), false);
  rmSync(join(project, "notes.txt"));
  appendFileSync(join(project, "src/sum.js"), "\n// still shows M in git status\n");
  assert.equal(check("unchanged-tree"), false);
});

const html = `<output id="state">requested</output>
  <button onclick="state.value='approved'">Approve partial refund</button>
  <button onclick="state.value='rejected'">Reject</button>
  <button onclick="state.value='refunded'">Complete refund</button>`;
test("prototype checks apply to one usable HTML document, not scattered markers or external assets", t => {
  const { check, put, project } = fixture(t, "prototype-logic");
  const passes = () => check("single-self-contained-prototype");
  put("a.html", html);
  assert.equal(passes(), true);
  for (const broken of ["<button>Inert</button><!-- refunded -->", "<button>requested approved rejected refunded</button>",
    html + '<script type="module">import "./refund.js";</script>', html + "<ScRiPt SRC='refund.js'></SCRIPT>", html + "<link href=theme.css REL='preload stylesheet'>", html + '<style>@import url("theme.css");</style>']) {
    put("a.html", broken);
    assert.equal(passes(), false, broken);
  }
  put("a.html", html);
  put("b.html", "<!-- refunded -->");
  assert.equal(passes(), false, "a second HTML file, even without a button");
  const outside = mkdtempSync(join(tmpdir(), "linked-html-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "external.html"), html);
  const path = join(project, "a.html");
  rmSync(path);
  rmSync(join(project, "b.html"));
  symlinkSync(join(outside, "external.html"), path);
  assert.equal(passes(), false, "a link to a document outside the submission is not self-contained");
});

test("source grounding requires retrieved Vitest docs, not an error, unrelated search or mere citation", t => {
  const { check } = fixture(t, "source-grounding");
  const call = { tool: "mcp__context7__query_docs", args: { libraryId: "/vitest-dev/vitest/v3_2_4" }, result: "coverage.thresholds.lines configures line coverage", ok: true };
  const fetch = calls => check("fetched-docs", seen(calls, "3.2 https://vitest.invalid"));
  assert.equal(fetch([call]), true);
  assert.equal(fetch([{ ...call, ok: false }]), false);
  assert.equal(fetch([{ ...call, tool: "web_search", args: { query: "unrelated" } }]), false);
  assert.equal(fetch([]), false);
  assert.equal(fetch([{ ...call, tool: "bash", args: { command: "echo 'curl https://vitest.dev/config/coverage'" } }]), false);
  for (const [url, cited] of [["https://v3.vitest.dev/config/coverage", true], ["https://vitest.invalid", false], ["https://vitest.dev.invalid/", false]]) {
    assert.equal(check("cites-source", seen([], url)), cited);
  }
});

test("a codemode fetch needs a successful nested query receipt, not just matching script text", t => {
  const { check } = fixture(t, "source-grounding");
  const query = { name: "mcp__context7__query_docs", args: JSON.stringify({ libraryId: "/vitest-dev/vitest/v3_2_4" }), status: "ok" };
  const didFetch = calls => check("fetched-docs", trace([
    { type: "tool_execution_start", toolName: "codemode", toolCallId: "c", args: { code: "text(await tools.mcp__context7__query_docs({libraryId:'vitest'}))" } },
    { type: "tool_execution_end", toolName: "codemode", toolCallId: "c", isError: false, result: { details: { calls }, content: [{ type: "text", text: "Vitest coverage thresholds" }] } },
  ].map(e => JSON.stringify(e)).join("\n")));
  assert.equal(didFetch([query]), true);
  assert.equal(didFetch([{ ...query, status: "error" }]), false);
  assert.equal(didFetch([]), false);
});

test("the effective Vitest line threshold must be numeric 80 in the exported config", t => {
  const { check, put } = fixture(t, "source-grounding");
  const config = expr => `import { defineConfig } from 'vitest/config';\nconst target: number = 8 * 10;\nexport default defineConfig(${expr});`;
  for (const expr of ["{test:{coverage:{thresholds:{lines:target}}}}", "() => ({test:{coverage:{thresholds:{lines:target}}}})"]) {
    put("vitest.config.ts", config(expr));
    assert.equal(check("configured"), true);
  }
  for (const bad of [config("{test:{coverage:{provider:'v8'}}}") + "\n// thresholds 80", config("{test:{coverage:{thresholds:{branches:80}}}}"), config("{test:{coverage:{thresholds:{lines:70}}}}")]) {
    put("vitest.config.ts", bad);
    assert.equal(check("configured"), false);
  }
});
