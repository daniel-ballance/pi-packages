import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const skills = new URL("../skills/", import.meta.url);
const read = path => readFileSync(new URL(path, skills), "utf8");
const router = read("p3stack-mode/SKILL.md");
const rows = [...router.matchAll(/^\| (.+?) \| (any|default|full-autonomy) \| (.+) \|$/gm)]
  .map(([, request, grant, next]) => ({ request, grant, next }));
const route = path => rows.find(row => row.next === `\`${path}\``);

test("only the narrow small-task row bypasses both reads", () => {
  const [first, ...routed] = rows;
  assert.match(first.request, /exact edit.*file|file.*exact edit/i);
  assert.match(first.request, /one (?:code )?fact.*(?:one|single) function/i);
  assert.equal(first.grant, "any");
  assert.ok(routed.every(({ next }) => /^`[^\s]+`$/.test(next)));
  for (const boundary of [/unclear cause/i, /more than one file|multiple files/i, /new behavior/i, /risk/i]) {
    assert.match(first.next, boundary);
  }
  assert.match(first.next, /inspect.*edit only if asked.*nearest existing check.*reply/i);
  const entry = router.split("## Grants")[0];
  assert.match(entry, /small.task[^\n]*no poteto-mode[^\n]*playbook/i);
  assert.match(entry, /choose.*route[^\n]*read `poteto-mode\/SKILL\.md` in full[^\n]*then (?:read )?the (?:selected )?target/i);
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
  for (const text of [router, read("poteto-mode/playbooks/bug-fix.md")]) {
    assert.match(text, diagnosis);
    assert.match(text, /step 3/i);
    assert.doesNotMatch(text, /continue Bug fix from the plan step/i);
  }
});

test("a task-only grant raise reaches the delegate despite its session header", () => {
  const grants = router.split("## Grants")[1].split("## House policies")[0];
  assert.match(grants, /system prompt/i);
  assert.match(grants, /explicit.*full autonomy.*task/i);
  assert.match(grants, /(?:each|every) (?:delegation )?brief/i);
  assert.match(grants, /header.*session grant/i);
  assert.doesNotMatch(grants, /infer (?:it|the grant) from the request/i);
});
