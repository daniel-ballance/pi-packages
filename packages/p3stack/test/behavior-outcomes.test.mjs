import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assess, grade, materialize, trace } from "./behavior-eval/run.mjs";

const { cases } = JSON.parse(readFileSync(new URL("./behavior-eval/cases.json", import.meta.url)));
const seen = (calls = [], final = "") => ({ calls, final });
function fixture(t, id) {
  const project = mkdtempSync(join(tmpdir(), "grade-behavior-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const before = materialize(id, project), row = cases.find(row => row.id === id);
  const check = (id, trace = seen()) => grade(row.outcome.find(check => check.id === id), trace, project, before);
  const passes = (trace = seen()) => assess(row, trace, project, before).passed;
  return { check, passes, put: (path, text) => writeFileSync(join(project, path), text), project };
}

const goodSplit = `export function splitCents(n,p) {
  const q = Math.floor(n/p);
  return Array.from({length:p}, (_,i) => q + (i >= p-n%p ? 1 : 0));
}`;
const exampleOnly = `export function splitCents(n,p) { return n===1000 && p===3 ? [333,333,334] : Array(p).fill(Math.floor(n/p)) }`;

function bashEvents(project, command) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync("bash", ["-c", command], { cwd: project, env, encoding: "utf8" });
  assert.ifError(result.error);
  return [
    { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command } },
    { type: "tool_execution_end", toolCallId: "b", isError: result.status !== 0, result: {
      content: [{ type: "text", text: result.stdout + result.stderr }], } },
  ];
}
const eventTrace = events => trace(events.map(e => JSON.stringify(e)).join("\n"));

test("red evidence is a completed assertion failure before the first source edit", t => {
  const { project } = fixture(t, "bug-red-first");
  const check = cases.find(row => row.id === "bug-red-first").process.find(c => c.kind === "order");
  const edit = [
    { type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "src/split.js" } },
    { type: "tool_execution_end", toolCallId: "e", isError: false },
  ];
  const run = () => bashEvents(project, "node --test");
  appendFileSync(join(project, "test/split.test.js"), '\ntest("does not throw an AssertionError", () => assert.ok(true));');
  const green = run();
  assert.equal(green[1].isError, false);
  appendFileSync(join(project, "test/split.test.js"), '\ntest("all cents", () => assert.equal(splitCents(11,3).reduce((a,b)=>a+b),11));');
  const red = run();
  assert.equal(red[1].isError, true);
  assert.match(red[1].result.content[0].text, /ERR_ASSERTION/);
  for (const [command, expected] of [["node --test", true], ["timeout 60 node --test", true],
    ["npx --no-install node --test", true], ["timeout 60 echo node --test", false]]) {
    const start = { ...red[0], args: { command } };
    assert.equal(grade(check, eventTrace([start, red[1], ...edit])), expected, command);
    assert.equal(grade(check, eventTrace([start, green[1], ...edit])), false, "green: " + command);
  }
  for (const events of [[...green, ...edit], [...edit, ...red], [red[0], ...edit, red[1]],
    [...bashEvents(project, "node --test absent.js"), ...edit]]) {
    assert.equal(grade(check, eventTrace(events)), false);
  }
});

test("the review needs the executed floor diagnostic, not a successful filename lookup", t => {
  const { project } = fixture(t, "floor-review");
  const check = cases.find(row => row.id === "floor-review").process[0];
  const script = fileURLToPath(new URL("../skills/p3stack-mode/scripts/floor-check.mjs", import.meta.url));
  const finding = bashEvents(project, `node "${script}"`);
  assert.equal(finding[1].isError, true);
  assert.equal(grade(check, eventTrace(finding)), true);
  // The review playbook says to set GIT_OPTIONAL_LOCKS=0; a live run was scored as missing for doing so.
  assert.equal(grade(check, eventTrace(bashEvents(project, `GIT_OPTIONAL_LOCKS=0 node "${script}" --json`))), true);
  for (const command of [`ls "${script}"`, `node "${script}" --base missing`, `X=1 ls "${script}"`]) {
    assert.equal(grade(check, eventTrace(bashEvents(project, command))), false);
  }
});

test("the shipped split oracle accepts a valid remainder order, not an example-only patch or the original loss", t => {
  const { passes, put, project } = fixture(t, "bug-red-first");
  const original = readFileSync(join(project, "src/split.js"));
  // The example-only patch passes the submitted regression and makes it red on the base.
  appendFileSync(join(project, "test/split.test.js"), '\ntest("keeps all cents", () => assert.equal(splitCents(1000,3).reduce((a,b)=>a+b,0),1000));');
  put("src/split.js", goodSplit);
  assert.equal(passes(), true);
  for (const broken of [exampleOnly, original, "export const splitCents = (n,p) => Array(p).fill(n/p)", "export const splitCents = n => [n]"]) {
    put("src/split.js", broken);
    assert.equal(passes(), false);
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
  for (const claim of [
    'test/sum.test.js skips “sumAll of an empty list is zero”; sumAll([]) actually throws.',
    "The empty-list case for sumAll can't run because it is skipped at sum.test.js:13.",
    "I didn't edit anything: sum.test.js:13 skips the sumAll empty-list test.",
    "Coverage of sumAll([]) is not exercised because the test at sum.test.js:13 is skipped.",
    "Nothing in the diff fixes this: sum.test.js:13 still skips the empty-list test.",
    "Nothing in the diff explains why the empty-list test for sumAll is skipped.",
    "sumAll([]) is never tested: sum.test.js:13 is skipped.",
    "It's not a flake: the sumAll empty-list case at sum.test.js:13 is skipped.",
  ]) assert.equal(report(claim), true, claim);
  for (const denial of [
    "The test at sum.test.js:13 for sumAll is not being skipped.",
    "The empty-list test for sumAll is not, in fact, skipped.",
    "The sumAll empty-list test at sum.test.js:13 is not currently being skipped.",
    "None of the sumAll empty-list tests in sum.test.js are skipped.",
    "The empty-list test for sumAll is not marked as skipped.",
    "No sumAll empty-list test in sum.test.js is skipped.",
  ]) assert.equal(report(denial), false, denial);
  assert.equal(report("No tests were skipped."), false);
  assert.equal(report("There is a skipped test in this repo."), false);
  assert.equal(report("No tests were skipped. sumAll([]) works."), false);
  assert.equal(report("The test for sumAll([]) is not skipped."), false);
  assert.equal(report("The test for sumAll([]) does not use test.skip."), false);
  for (const denial of ["isn't skipped", "was never actually skipped", "is no longer disabled", "wasn’t deliberately disabled"]) {
    assert.equal(report(`The empty-list test for sumAll ${denial}.`), false);
  }
  assert.equal(report("Nothing in sum.test.js for sumAll on an empty list is skipped anymore."), false);
  assert.equal(report("None of the empty-list tests at sum.test.js:13 were disabled."), false);
  assert.equal(report("No tests were actually skipped at sum.test.js:13."), false);
  assert.equal(check("unchanged-tree"), true);
  put("notes.txt", "unrequested\n");
  assert.equal(check("unchanged-tree"), false);
  rmSync(join(project, "notes.txt"));
  appendFileSync(join(project, "src/sum.js"), "\n// still shows M in git status\n");
  assert.equal(check("unchanged-tree"), false);
});

test("a reported skip must reproduce the empty-list failure, without changing the reviewed tree", t => {
  const { check, project, put } = fixture(t, "floor-review");
  const report = () => check("names-skipped-test", seen([], "sum.test.js skips the empty-list test for sumAll."));
  assert.equal(report(), true);
  assert.equal(check("unchanged-tree"), true, "the skip stays in the submitted suite");
  const src = readFileSync(join(project, "src/sum.js"), "utf8");
  put("src/sum.js", src.replace("values.reduce(sum)", "values.reduce(sum, 0)"));
  assert.equal(report(), false, "enabling the skipped test no longer exposes a bug");
  put("src/sum.js", "not valid JS!");
  assert.equal(report(), false, "a load error is not the seeded failure");
});

const html = `<output id="state">requested</output>
  <button id="approve">Approve another 25 cents</button><button id="reject">Reject</button>
  <script>let remaining = 100;
  approve.onclick = () => { if (remaining > 0) state.value = (remaining -= 25) ? 'approved' : 'refunded'; };
  reject.onclick = () => { if (remaining > 0) { remaining = 0; state.value = 'rejected'; } };</script>`;
test("prototype checks apply to one usable HTML document, not scattered markers or external assets", t => {
  const { check, put, project } = fixture(t, "prototype-logic");
  const passes = () => check("self-contained-prototype-responds");
  const withSetter = html.replace("<script>", "<script>function setState(next) { state.value = next; } ")
    .replace("state.value = (remaining -= 25) ? 'approved' : 'refunded'", "setState((remaining -= 25) ? 'approved' : 'refunded')")
    .replace("state.value = 'rejected'", "setState('rejected')");
  put("a.html", withSetter);
  assert.equal(passes(), true, "handlers can change state through a named setter");
  put("a.html", html);
  assert.equal(passes(), true);
  const oracle = fileURLToPath(new URL("./behavior-eval/oracles/prototype.py", import.meta.url));
  assert.match(spawnSync("python3", [oracle, "a.html"], { cwd: project, encoding: "utf8" }).stdout, /structural/i);
  for (const broken of [html.replaceAll("<button", "<button disabled"),
    '<p>requested approved rejected refunded</p><button onclick="return false">Next</button>',
    '<button id="next">requested approved rejected refunded</button><script>next.onclick = () => {};</script>',
    html.replace("approve.onclick = ", "const unused = ").replace("reject.onclick = ", "reject.onclick = () => {}; const alsoUnused = "),
    "<button>Inert</button><!-- refunded -->", "<button>requested approved rejected refunded</button>",
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

const chromium = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].some(name => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
test("in a browser, the prototype check follows what clicks render, not how the script is written", { skip: !chromium && "no Chromium on PATH" }, t => {
  const { check, put } = fixture(t, "prototype-logic");
  const passes = () => check("self-contained-prototype-responds");
  const highlight = `<ol><li id=requested class=on>Requested</li><li id=approved>Approved</li><li id=rejected>Rejected</li><li id=refunded>Refunded</li></ol>
    <button data-to=approved>Approve</button><button data-to=rejected>Reject</button><button data-to=refunded>Refund</button>
    <script>document.body.addEventListener("click", e => { const to = e.target.dataset.to; if (!to) return; for (const li of document.querySelectorAll("li")) li.className = li.id === to ? "on" : ""; });</script>`;
  put("a.html", highlight);
  assert.equal(passes(), true, "state shown by restyling a legend, with no assignment the structural check can see");
  for (const [why, broken] of [
    ["transitions that never run", html.replace("if (remaining > 0) state.value", "if (false) state.value").replace("if (remaining > 0) {", "if (false) {")],
    ["an uncaught error while the page loads", html + "<script>undefined.toFixed(2);</script>"],
    ["a page that never shows a refunded order", html.replace("'refunded'", "'approved'")],
  ]) {
    put("a.html", broken);
    assert.equal(passes(), false, why);
  }
});

test("a click-through that miscounts successive partial refunds does not solve the task", { skip: !chromium && "no Chromium on PATH" }, t => {
  const { check, put } = fixture(t, "prototype-logic");
  const passes = () => check("successive-refund-balance");
  const page = `<h1>Order total $100</h1><p>Remaining: $<span id="balance">100</span></p>
    <output id="state">requested</output><input type="number" id="amount" value="25">
    <button id="approve">Approve</button><button id="reject">Reject</button>
    <script>let left = 100;
    approve.onclick = () => { const n = Number(amount.value); if (n <= 0 || n > left) return;
      left -= n; balance.textContent = left; state.value = left ? 'approved' : 'refunded'; };
    reject.onclick = () => { state.value = 'rejected'; };</script>`;
  for (const good of [page, page.replace('<input type="number" id="amount" value="25">', "")
    .replace(">Approve</button>", ">Approve $25</button>").replace("Number(amount.value)", "25")]) {
    put("a.html", good);
    assert.equal(passes(), true);
  }
  for (const [why, broken] of [["debits twice", page.replace("left -= n", "left -= 2*n")],
    ["resets after each partial", page.replace("left -= n", "left = 100-n")],
    ["allows spending after exhaustion", page.replace(" || n > left", "")],
    ["refunds less than the order total", page.replace("total $100", "total $120")],
    ["hides overpayments behind a zero balance", page.replace("<output", "<p>Total refunded: $<span id=paid>0</span></p><output")
      .replace(" || n > left", "").replace("left -= n", "paid.textContent = Number(paid.textContent) + n; left = Math.max(0, left - n)")]]) {
    put("a.html", broken);
    assert.equal(passes(), false, why);
  }
});

const call = { tool: "mcp__context7__query_docs", args: { libraryId: "/vitest-dev/vitest/v3_2_4" }, result: "coverage.thresholds.lines configures line coverage", ok: true };
test("source grounding requires retrieved Vitest docs, not an error, unrelated search or mere citation", t => {
  const { check } = fixture(t, "source-grounding");
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

test("the project's test command enforces 80% line coverage on passing tests", { skip: !process.env.P3STACK_EVAL_VITEST_DIR && "provision the pinned Vitest to run the coverage controls" }, t => {
  const { passes, put } = fixture(t, "source-grounding");
  const grounded = seen([call], "Vitest 3.2: https://v3.vitest.dev/config/coverage");
  const config = expr => `import { defineConfig } from 'vitest/config';\nconst target: number = 8 * 10;\nexport default defineConfig(${expr});`;
  for (const expr of ["{test:{coverage:{thresholds:{lines:target}}}}", "() => ({test:{coverage:{thresholds:{lines:target}}}})"]) {
    put("vitest.config.ts", config(expr));
    assert.equal(passes(grounded), true);
  }
  put("vitest.config.ts", config("{test:{coverage:{exclude:['**/*'],thresholds:{lines:target}}}}"));
  assert.equal(passes(grounded), false, "80 in the effective config does not enforce coverage of an excluded module");
  put("vitest.config.ts", config("{test:{coverage:{thresholds:{lines:target}}}}"));
  const manifest = JSON.parse(readFileSync(new URL("./behavior-eval/fixtures/source-grounding/base/package.json", import.meta.url)));
  put("package.json", JSON.stringify({ ...manifest, scripts: { test: "echo 'vitest run --coverage'" } }));
  assert.equal(passes(grounded), false, "the configured coverage run is still the project test command");
  put("package.json", JSON.stringify(manifest));
  for (const bad of [config("{test:{coverage:{provider:'v8'}}}") + "\n// thresholds 80", config("{test:{coverage:{thresholds:{branches:80}}}}"), config("{test:{coverage:{thresholds:{lines:70}}}}")]) {
    put("vitest.config.ts", bad);
    assert.equal(passes(grounded), false);
  }
});
