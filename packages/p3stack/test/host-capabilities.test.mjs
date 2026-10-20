import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const hostMap = () => readFileSync(new URL("../skills/poteto-mode/references/host-capabilities.md", import.meta.url), "utf8");
const section = heading => hostMap().split(`## ${heading}\n`)[1].split("\n## ")[0];

test("delegate line 8 distinguishes a lost-call retry from a new round", () => {
  const line = hostMap().split("\n")[7];
  assert.match(line, /^- \*\*T3\.\*\*/);
  assert.match(line, /same `clientRequestId`.*lost call/);
  assert.match(line, /new `clientRequestId`.*new round/);
  assert.match(line, /`role`/);
  assert.match(line, /`options`.*`thinking`/);
  assert.match(section("Delegate"), /subagent_wait` with `final: true`/);
  assert.match(section("Delegate"), /coordination\.owns/);
});

test("opening a PR cites the Pull requests section and records its chain", () => {
  const opening = readFileSync(new URL("../skills/poteto-mode/playbooks/opening-a-pr.md", import.meta.url), "utf8");
  assert.match(opening, /Read \*\*Pull requests\*\* in the \[host capabilities\]\(references\/host-capabilities\.md\)/);
  const chains = readFileSync(new URL("../skills/p3stack-mode/references/chains.md", import.meta.url), "utf8");
  assert.match(chains, /opening-pr-host-link/);
  assert.match(chains, /Pull requests/);
});

test("recall reads Session history before it mines chats", () => {
  const recall = readFileSync(new URL("../skills/recall/SKILL.md", import.meta.url), "utf8");
  assert.match(recall, /Before searching, read \*\*Session history\*\* in the \[host capabilities\]\(\.\.\/poteto-mode\/references\/host-capabilities\.md\)/);
  assert.match(recall, /Use its host-specific sources for parent sessions and child history/);
});

test("host map documents scheduling, preview, history, and PR handback", () => {
  const wake = section("Wake and loop");
  for (const shape of ['{"type":"interval","everyMs":3600000}', '{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}', '{"type":"webhook"}']) assert.ok(wake.includes(shape), shape);
  assert.match(wake, /delete_scheduled_task/);
  assert.match(section("Visuals"), /html_preview.*html_render/);
  for (const name of ["t3_thread_search", "t3_thread_list", "parentThreadId"]) assert.ok(section("Session history").includes(name), name);
  assert.match(section("Pull requests"), /list_thread_pull_requests.*before.*hand/);
});
