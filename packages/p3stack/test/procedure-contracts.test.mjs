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

test("a body-only request uses the same format as PR delivery without publishing", () => {
  const pr = skill("pr"), opening = playbook("opening-a-pr");
  assert.match(pr, /Descriptions[^\n]*opening-a-pr\.md/i);
  assert.match(pr, /return (?:just|only) the body/i);
  assert.doesNotMatch(pr, /^## (?:Summary|Evidence|Merge Danger)$/m);
  assert.match(opening, /repository[^\n]*PR template[^\n]*(?:otherwise|absence|without one)/i);
  assert.match(opening, /## Verification/);
});

test("an integration queue opens a draft, links it, and promotes the reviewed head", () => {
  const spec = skill("implement-spec"), opening = playbook("opening-a-pr");
  assert.match(spec, /tracker closes work through PRs[^\n]*draft[^\n]*first merge[^\n]*opening-a-pr\.md/i);
  assert.match(spec, /final integration head[^\n]*review[^\n]*same PR ready/i);
  assert.match(spec, /(?:otherwise|without a PR|if there is no PR)[^\n]*report the integration branch/i);
  assert.match(opening, /integration (?:draft|queue)[^\n]*(?:--draft|draft: true)/i);
  assert.match(opening, /ready for review[^\n]*draft: false/i);
  assert.match(opening, /host integration[^\n]*draft/i);
  assert.match(opening, /before (?:opening|marking)[^\n]*ready[^\n]*verdict on the changed diff/i);
  assert.doesNotMatch(opening, /open every PR ready|draft: false` on every creation|if a PR still opens as a draft/i);
});

test("triage posts observable acceptance criteria, including on a state override", () => {
  const triage = skill("triage"), tracker = read("triage/AGENT-BRIEF.md");
  assert.match(triage, /`ready-for-agent`: post [^\n]*tracker brief[^\n]*AGENT-BRIEF\.md/);
  assert.match(triage.split("## Quick state override")[1], /ask whether[^\n]*tracker brief/i);
  const positive = tracker.split(/### Bad .*brief/i)[0];
  assert.match(positive, /private[^\n]*brief-contract\.md/i);
  assert.doesNotMatch(positive, /authoritative specification|name specific types|\*\*Key interfaces:\*\*|TypeName|SkillConfig|reuse the existing serializer/i);
  const comments = [...positive.matchAll(/```markdown\n([^`][\s\S]*?)\n```/g)].map(match => match[1]);
  assert.ok(comments.some(comment => comment.includes("Category:** bug")));
  assert.ok(comments.some(comment => comment.includes("--json")), "attached PR");
  for (const comment of comments) {
    for (const field of ["Current behavior", "Desired behavior", "Acceptance criteria", "Out of scope"]) assert.ok(comment.includes(`**${field}:**`), field);
    assert.match(comment, /- \[ \] /);
  }
});

test("each newly unblocked ticket gets a private brief against the assigned revision", () => {
  const spec = skill("implement-spec"), contract = read("p3stack-mode/references/brief-contract.md");
  assert.match(spec, /each dispatch[^\n]*integration (?:base|tip)[^\n]*private[^\n]*brief-contract\.md/i);
  assert.match(contract, /acceptance criteria in the tracker ticket/i);
  assert.match(contract, /at dispatch[^\n]*signatures[^\n]*paths[^\n]*done command[^\n]*brief/i);
});
