import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
    const file = readFileSync(new URL(`../resources/prompts/t3-${name}.md`, import.meta.url), "utf8");
    const body = file.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    assert.match(body.split("\n")[0]!, stop);
    if (name !== "chart" && name !== "handoff") {
      assert.match(body, /when p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line/i);
      assert.match(body, /without (?:that|the) reminder:/i);
    }
    assert.ok(body.includes(standaloneTool), "the standalone procedure is still available");
  });
}
