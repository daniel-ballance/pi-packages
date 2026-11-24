import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentDir, resolveRoles } from "../extensions/p3stack/src/roles.ts";

function env(t: TestContext, key: string, value?: string) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

function directories(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-roles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), personal = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(personal);
  env(t, "PI_CODING_AGENT_DIR", personal);
  return { cwd, personal: join(personal, "p3stack.json"), project: join(cwd, ".pi", "p3stack.json") };
}

test("the agent directory follows Pi for empty, tilde and explicit overrides", t => {
  env(t, "PI_CODING_AGENT_DIR", "");
  assert.equal(agentDir(), join(homedir(), ".pi", "agent"));
  process.env.PI_CODING_AGENT_DIR = "~/pi-tests";
  assert.equal(agentDir(), join(homedir(), "pi-tests"));
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "ordinary");
  assert.equal(agentDir(), join(tmpdir(), "ordinary"));
});

test("an invalid trusted role file is reported without masking personal defaults", t => {
  const { cwd, project, personal } = directories(t);
  writeFileSync(personal, JSON.stringify({ roles: { "bug-fix": "pi/gpt-6:medium" } }));
  for (const invalid of ["{", JSON.stringify({ roles: [] })]) {
    writeFileSync(project, invalid);
    const result = resolveRoles(cwd, true);
    assert.equal(result.source, personal);
    assert.equal(result.roles["bug-fix"].value, "pi/gpt-6:medium");
    assert.ok(result.problems.some(problem => problem.includes(project)));
  }
});
