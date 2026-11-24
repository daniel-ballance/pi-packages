import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const skills = new URL("../skills/", import.meta.url);
const read = path => readFileSync(new URL(path, skills), "utf8");
const router = read("p3stack-mode/SKILL.md");
const rows = [...router.matchAll(/^\| (.+?) \| (any|default|full-autonomy) \| (.+) \|$/gm)]
  .map(([, request, grant, next]) => ({ request, grant, next }));
const route = path => rows.find(row => row.next === `\`../poteto-mode/SKILL.md\`, then \`../${path}\``);

test("only the narrow small-task row bypasses both reads", () => {
  const [first, ...routed] = rows;
  assert.match(first.request, /exact edit.*file|file.*exact edit/i);
  assert.match(first.request, /one (?:code )?fact.*(?:one|single) function/i);
  assert.equal(first.grant, "any");
  assert.ok(routed.every(({ next }) => /^`\.\.\/poteto-mode\/SKILL\.md`, then `\.\.\/[^\s]+`$/.test(next)), "every routed row names both reads");
  for (const boundary of [/unclear cause/i, /more than one file|multiple files/i, /new behavior/i, /risk/i]) {
    assert.match(first.next, boundary);
  }
  assert.match(first.next, /inspect.*edit only if asked.*nearest existing check.*reply/i);
  const entry = router.split("## Grants")[0];
  assert.match(entry, /relative to this file's directory/i);
  assert.match(entry, /small.task[^\n]*no poteto-mode[^\n]*playbook/i);
  assert.match(entry, /next two tool calls[^\n]*poteto-mode in full, then the target/i);
});

test("every playbook is selectable before the fallback, with or without merge authority", () => {
  for (const dir of ["poteto-mode", "p3stack-mode"]) {
    for (const name of readdirSync(new URL(`${dir}/playbooks/`, skills))) {
      assert.ok(route(`${dir}/playbooks/${name}`), name);
    }
  }
  assert.match(route("poteto-mode/playbooks/autopilot-full.md").request, /approved.*merge/i);
  assert.match(route("poteto-mode/playbooks/autopilot-stack.md").request, /approved.*operator/i);
  assert.equal(rows.at(-1), route("figure-it-out/SKILL.md"));
});

test("a missing reproduction changes the first target, not the owner of the fix", () => {
  assert.match(route("diagnosing-bugs/SKILL.md")?.request ?? "", /without.*failing repro/i);
  assert.match(route("poteto-mode/playbooks/bug-fix.md").request, /with a failing repro/i);
  const diagnosis = /reproduc(?:ed|e) (?:the )?failure.*confirm(?:ed)? (?:its |the )?cause/i;
  assert.match(router, diagnosis);
  assert.match(router, /before its fix[^\n]*debug tag[^\n]*probe paths[^\n]*step 3/i);
  assert.match(router, /bug-fix\.md[^\n]*step 3[^\n]*(?:through|to the end)[^\n]*(?:delivery|opening a PR)/i);
  const bug = read("poteto-mode/playbooks/bug-fix.md");
  const afterFix = bug.split("3. Plan the fix.")[1].split("[floor]")[0];
  assert.match(afterFix, /remove[^\n]*tagged[^\n]*throwaway probes[^\n]*rerun the original repro/i);
  assert.match(afterFix, /regression test/);
});

test("the first house policy caps every route at the requested deliverable", () => {
  const policies = router.split("## House policies")[1].split("## Routes")[0];
  const [first, ...rest] = policies.match(/^\d+\. .*$/gm);
  assert.match(first, /\*\*Deliverable\b/);
  for (const term of ["review", "explain", "design", "prototype", "plan", "report", "recommendation", "demo", "implement", "publish", "PR", "babysit", "land"]) {
    assert.ok(first.toLowerCase().includes(term.toLowerCase()), term);
  }
  for (const policy of ["Authority", "Questions", "Validation", "Migration", "Testing", "Review independence", "Context", "Style"]) {
    assert.ok(rest.some(line => line.includes(`**${policy}.**`)), policy);
  }
});

test("a stakeholder demo replaces the generic build and stops before either production handoff", () => {
  const prototype = read("poteto-mode/playbooks/prototype.md");
  const build = prototype.split("3. Build throwaway")[0];
  assert.match(build, /replace step 3[^\n]*logic or UI/i);
  assert.match(build, /before[^\n]*capture/i);
  const handoff = prototype.split("Hand the chosen direction")[0];
  assert.match(handoff, /stop at the checked demo/i);
  assert.match(handoff, /full autonomy[^\n]*verdict[^\n]*pending/i);
});

test("local review checks the same artifact throughout and returns only findings", () => {
  const path = "p3stack-mode/playbooks/review-local.md";
  assert.equal(route(path)?.request, "Review my change");
  assert.match(route("no-comments/SKILL.md").request, /clean.*comments/i);
  const review = read(path);
  const triggers = read("poteto-mode/SKILL.md").split("## Principles")[0];
  for (const action of ["Before review", "Broken skill mid-task"]) {
    assert.match(triggers.split("\n").find(line => line.includes(action)), /write-authorized route.*→/i);
  }
  assert.match(review, /skip[^\n]*cleanup[^\n]*pull request[^\n]*repair/i);
  assert.match(review, /GIT_OPTIONAL_LOCKS=0|--no-optional-locks/);
  assert.match(review, /read.only/i);
  assert.match(review, /return the report in your reply/i);
  assert.match(review, /merge-base/);
  assert.match(review, /staged.*unstaged.*untracked/i);
  const scan = review.split("**Scan the floor.**")[1].split("\n")[0];
  assert.match(scan, /--base <base>/);
  assert.match(scan, /submodule[^\n]*gitlink[^\n]*parent[^\n]*base/i);
  assert.match(scan, /report the gap/i);
  const floor = review.indexOf("floor-check"), reviewSkill = review.indexOf("](../code-review/SKILL.md)");
  const baseline = review.indexOf("checkout-fingerprint.mjs");
  assert.ok(baseline >= 0 && baseline < floor && floor < reviewSkill);
  assert.match(review, /\]\(references\/review-stance\.md\)/);
  assert.match(review, /contract/i);
  assert.match(review, /file:line|command output/i);
  assert.match(review.slice(reviewSkill), /(?:repeat|compare|rerun).*fingerprint/i);
  assert.match(review.slice(reviewSkill), /working tree.*unchanged/i);
});

test("a task-only grant raise reaches the delegate despite its session header", () => {
  const grants = router.split("## Grants")[1].split("## House policies")[0];
  assert.match(grants, /system prompt/i);
  assert.match(grants, /explicit.*full autonomy.*task/i);
  for (const doc of [grants, read("p3stack-mode/references/brief-contract.md")]) {
    assert.match(doc, /header.*session grant/i);
    assert.match(doc, /parent[^\n]*Task grant:[^\n]*(?:higher or lower|raise[^\n]*lower)/i);
    assert.match(doc, /child never raises its own grant/i);
    assert.match(doc, /operator gates[^\n]*(?:any|either) grant/i);
  }
  assert.match(grants, /architect[^\n]*design synthesis[^\n]*recommendation/i);
  assert.doesNotMatch(grants, /infer (?:it|the grant) from the request/i);
});
