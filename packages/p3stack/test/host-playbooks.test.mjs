import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skill = path => readFileSync(new URL(`../skills/poteto-mode/${path}`, import.meta.url), "utf8");

for (const [book, capability] of [["babysit", "pull-requests"], ["session-pickup", "session-history"], ["worktree-cleanup", "isolation"]]) {
  test(`${book} selects ${capability} without assuming a host`, () => {
    const text = skill(`playbooks/${book}.md`);
    assert.ok(text.includes(`references/host-capabilities.md#${capability})`));
    assert.doesNotMatch(text, /\bT3\b|host-(?:terminal|t3)\.md/);
  });
}

test("the shared delegation brief uses resolved roles, not a host's local recipe", () => {
  const brief = skill("SKILL.md").split("\n## Subagents\n")[1].split("\n## ")[0];
  assert.match(brief, /p3stack_roles/);
  assert.doesNotMatch(brief, /agents\/poteto-agent\.md|\b(?:grok|claude)-[\w.-]+/);
});
