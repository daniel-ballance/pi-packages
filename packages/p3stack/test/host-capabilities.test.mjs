import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hostToolNames } from "../generator/lint-hosts.mjs";

const file = host => new URL(`../skills/poteto-mode/references/host-${host}.md`, import.meta.url);
const map = host => readFileSync(file(host), "utf8");
function sections(document) {
  const [, ...parts] = document.split(/^## (.+)\n/gm);
  const result = new Map();
  for (let i = 0; i < parts.length; i += 2) result.set(parts[i], parts[i + 1]);
  return result;
}

test("each capability links to the same heading on each host", () => {
  const entry = sections(map("capabilities"));
  assert.ok(entry.has("Delegate"));
  assert.ok(!entry.has("Verify host compatibility"));
  for (const host of ["terminal", "t3"]) {
    assert.deepEqual(new Set(sections(map(host)).keys()), new Set(entry.keys()), host);
    for (const [heading, body] of entry) {
      const fragment = heading.toLowerCase().replaceAll(" ", "-");
      const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
      for (const caller of ["poteto-mode", "code-review"]) {
        const base = new URL(`../skills/${caller}/`, import.meta.url);
        assert.ok(links.some(link => new URL(link, base).href === `${file(host)}#${fragment}`), `${caller}: ${heading} on ${host}`);
      }
    }
  }
});

test("host selection exposes only the selected host's operations", () => {
  const entry = map("capabilities");
  for (const marker of ["Host: terminal", "Host: t3", "mcp__t3-code__*"]) assert.ok(entry.includes(marker), marker);
  assert.deepEqual(new Set(hostToolNames(entry)), new Set(["mcp__t3-code__*"]));
  const terminal = hostToolNames(map("terminal")), t3 = hostToolNames(map("t3"));
  assert.ok(terminal.includes("subagent_spawn"));
  assert.ok(t3.includes("mcp__t3-code__delegate_task"));
  for (const tool of terminal) assert.ok(tool.startsWith("subagent_"), tool);
  for (const tool of t3) assert.ok(!tool.startsWith("subagent_"), tool);
});

test("opening a PR cites the Pull requests section and records its chain", () => {
  const opening = readFileSync(new URL("../skills/poteto-mode/playbooks/opening-a-pr.md", import.meta.url), "utf8");
  assert.match(opening, /Pull requests/i);
  assert.match(opening, /\]\(references\/host-capabilities\.md[#)]/);
  const chains = readFileSync(new URL("../skills/p3stack-mode/references/chains.md", import.meta.url), "utf8");
  assert.match(chains, /opening-pr-host-link/);
  assert.match(chains, /Pull requests/);
});

test("the workflow gate is a caller feature and the template helper resolves from the installed skill", () => {
  const workflow = sections(map("terminal")).get("Run a workflow");
  assert.match(workflow, /\bfeatures\.workflows\b/);
  const helper = workflow.match(/`node "([^"]*workflow-template\.mjs)"/)?.[1];
  const dir = fileURLToPath(new URL("../skills/poteto-mode", import.meta.url));
  assert.ok(helper?.startsWith("<poteto-mode-dir>/"), "missing absolute helper operand");
  assert.ok(existsSync(helper.replace("<poteto-mode-dir>", dir)), helper);
});

test("recall points history mining at the session history capability", () => {
  const recall = readFileSync(new URL("../skills/recall/SKILL.md", import.meta.url), "utf8");
  assert.match(recall, /Session history/i);
  assert.match(recall, /\]\(\.\.\/poteto-mode\/references\/host-capabilities\.md[#)]/);
});

test("PR handback does not request a thread's PR list", () => {
  for (const host of ["capabilities", "t3"]) {
    const pr = sections(map(host)).get("Pull requests");
    for (const instruction of pr.split(/[.\n]/)) {
      if (/hand[- ]?back|hand(?:ing)? (?:\w+ ){0,2}back|end[- ]of[- ]work|before returning/i.test(instruction)) {
        assert.doesNotMatch(instruction, /list_thread_pull_requests/);
      }
    }
  }
});
