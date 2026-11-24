import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../skills/${path}`, import.meta.url), "utf8");
const skill = name => read(`${name}/SKILL.md`);
const playbook = name => read(`poteto-mode/playbooks/${name}.md`);

test("architect hands a playbook its design without taking its implementation step", () => {
  const architect = skill("architect"), feature = playbook("feature");
  assert.match(architect, /design (?:request|step)[^\n]*synthesis[^\n]*(?:return|hand back)[^\n]*seams/i);
  assert.doesNotMatch(architect, /default: proceed directly to implementation|then fill in code against the chosen sketch/i);
  assert.match(architect, /only (?:when|if)[^\n]*assign[^\n]*implementation/i);
  assert.match(feature, /architect` for parallel design exploration/);
  assert.match(feature, /Delegate code-writing/);
  assert.match(skill("poteto-help"), /architect` returns a design unless/i);
});

test("tdd selects a public seam by grant before handing the loop to the writer", () => {
  const seams = skill("tdd").split("## Seams:")[1].split("## Anti-patterns")[0];
  assert.match(seams, /default[^\n]*confirm[^\n]*user/i);
  assert.match(seams, /full autonomy[^\n]*reversible[^\n]*record/i);
  assert.doesNotMatch(seams, /no test is written at an unconfirmed seam/i);
  assert.match(read("implement-spec/references/implement.md"), /\[tdd\][^\n]*select seams/i);
  assert.match(playbook("feature"), /\[tdd\][^\n]*seams[^\n]*implementation brief/i);
});

test("grilling returns a design without inventing an approval or starting a build", () => {
  const grill = skill("grilling");
  assert.match(grill, /no interview[^\n]*architect\/SKILL\.md[^\n]*recommendation/i);
  assert.match(grill, /one open question[^\n]*why[^\n]*without suggested answers/i);
  assert.match(grill, /frontier is empty[^\n]*95%[^\n]*return/i);
  assert.match(grill, /(?:approval|verdict|sign-off)[^\n]*pending/i);
  assert.doesNotMatch(grill, /until the user confirms you have reached a shared understanding/i);
});
