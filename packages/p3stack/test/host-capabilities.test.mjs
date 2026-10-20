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

test("host map documents scheduling, preview, history, and PR handback", () => {
  const wake = section("Wake and loop");
  for (const shape of ['{"type":"interval","everyMs":3600000}', '{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}', '{"type":"webhook"}']) assert.ok(wake.includes(shape), shape);
  assert.match(wake, /delete_scheduled_task/);
  assert.match(section("Visuals"), /html_preview.*html_render/);
  for (const name of ["t3_thread_search", "t3_thread_list", "parentThreadId"]) assert.ok(section("Session history").includes(name), name);
  assert.match(section("Pull requests"), /list_thread_pull_requests.*before.*hand/);
});
