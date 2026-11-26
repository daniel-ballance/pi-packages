import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { expandPromptTemplate, loadPromptTemplates } = await import(new URL("./core/prompt-templates.js", sdk).href);
const dir = fileURLToPath(new URL("../resources/prompts/", import.meta.url));
const { templates } = loadPromptTemplates({ cwd: dir, agentDir: dir, promptPaths: [dir], includeDefaults: false });
const prompt = (name: string, args = ""): string => expandPromptTemplate(`/t3-${name} ${args}`.trimEnd(), templates);
const skill = readFileSync(new URL("../resources/skills/t3-code/SKILL.md", import.meta.url), "utf8");

const intents = [
  ["ship", /open a pull request.*link.*do not watch or merge/i, "link_pull_request"],
  ["babysit", /ready-to-merge.*do not merge/i, "unwatch_pull_request"],
  ["review", /verified findings.*fix nothing unless asked/i, "delegate_task"],
  ["fanout", /split.*delegate.*merge.*locally.*no pull request/i, 'isolation:"worktree"'],
  ["chart", /answer.*chart.*stop/i, "html_render"],
  ["handoff", /move this thread.*stop.*handoff/i, "t3_worktree_handoff"],
] as const;

for (const [name, stop, standaloneTool] of intents) {
  test(`/t3-${name} opens with its deliverable and stop line`, () => {
    const body = prompt(name).trim();
    assert.match(body.split("\n")[0]!, stop);
    if (name !== "chart" && name !== "handoff") {
      assert.match(body, /when p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line/i);
      assert.match(body, /without (?:that|the) reminder:/i);
    }
    assert.ok(body.includes(standaloneTool), "the standalone procedure is still available");
  });
}

test("a delegate wave can finish dispatch before yielding to completion wakes", () => {
  for (const doc of [skill, prompt("fanout")]) {
    assert.match(doc, /(?:rest of|finish dispatching) the wave[^\n]*`next`/i);
    assert.match(doc, /completion wake[^\n]*`task_status`/i);
  }
});

test("babysit fixes failures and answers comments before falling back to a forge report", () => {
  const standalone = prompt("babysit").split("Without that reminder:")[1]!;
  for (const doc of [standalone, skill]) {
    const fix = doc.search(/fix (?:verified failures|failing checks)[^\n]*comments/i);
    const fallback = doc.search(/if\b[^\n]*?\beither[^\n]*(?:unavailable|absent)[^\n]*forge status[^\n]*stop/i);
    assert.ok(fix >= 0 && fallback > fix, "a missing watch must not skip the fix pass");
  }
});

test("babysit handles watch registration before yielding", () => {
  const standalone = prompt("babysit").split("Without that reminder:")[1]!;
  for (const doc of [standalone, skill]) {
    assert.match(doc, /`watching: false`[^\n]*report/i, "an inactive watch cannot wake the thread");
    assert.match(doc, /checks already pass[^\n]*recheck readiness/i, "the checks wake can be absent on registration");
    assert.match(doc, /yield only for a remaining blocker[^\n]*wake/i);
  }
  assert.match(standalone, /(?:if ready|if checks pass)[^.]*go to step 3/i, "a ready PR must still remove its watch");
});

test("review pins a default base and orders severity within each axis", () => {
  const review = prompt("review");
  assert.match(review, /Standards and Spec[^\n]*severity[^\n]*within each/i);
  assert.match(review, /git merge-base HEAD <default-branch>/);
  assert.match(review, /whether[^\n]*uncommitted work[^\n]*included/i);
});

test("handoff distinguishes a requested ref from a missing or invalid name after expansion", () => {
  for (const [args, name, valid] of [["", "", false], ["fix/pin", "fix/pin", true], ['"not a ref"', "not a ref", false], ["bad ref", "bad ref", false]] as const) {
    const handoff = prompt("handoff", args);
    const supplied = handoff.match(/^Requested branch:(.*)$/m)?.[1]?.trim();
    assert.equal(supplied, name);
    assert.match(handoff, /git check-ref-format --branch[^\n]*derive a valid unused name/i);
    assert.equal(spawnSync("git", ["check-ref-format", "--branch", name]).status === 0, valid);
  }
});
