import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { Workflows } from "../extensions/subagents/src/workflows.js";
import type { WorkflowHost } from "../extensions/subagents/src/workflow-host.js";
import { tempRoot } from "./support/temp-root.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const worker = { model: "test/stub:off", tools: [] as string[] };
const mode = (path: string) => statSync(path).mode & 0o777;

function host(): WorkflowHost {
  return {
    authorize() {},
    agents: async jobs => jobs.map(job => {
      writeFileSync(join(job.candidate, "value.txt"), job.step);
      return `Result ${job.step}`;
    }),
    command: async () => ({ code: 0, stdout: "" }),
  };
}

test("a fresh session's manager and workflows leave no directory until the first write", async () => {
  const root = tempRoot("lazy-state-");
  const session = join(root, "subagents", "session");
  const workflowsDir = join(session, "workflows");
  const manager = new SubagentManager(session);
  const engine = new Workflows(workflowsDir, host());
  try {
    assert.equal(existsSync(join(root, "subagents")), false);
    assert.equal(existsSync(session), false);
    assert.equal(existsSync(workflowsDir), false);
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(engine.list(), []);

    const spawned = await manager.spawn({ name: "worker", task: "go", cwd: root, executable: process.execPath, executableArgs: [fixture] });
    assert.equal(existsSync(session), true);
    assert.equal(existsSync(workflowsDir), false);
    if (process.platform !== "win32") assert.equal(mode(session), 0o700);
    await manager.wait([spawned.id], "all", 2000);
    await manager.close(spawned.id);

    const started = engine.start({
      version: 1, name: "test", cwd: root,
      limits: { concurrency: 1, maxAttempts: 5, timeoutSeconds: 30 },
      steps: [{ id: "a", kind: "task", worker, instructions: "a" }],
    }) as { id: string };
    assert.equal(existsSync(workflowsDir), true);
    if (process.platform !== "win32") assert.equal(mode(workflowsDir), 0o700);
    for (let n = 0; n < 400 && engine.get(started.id).status === "running"; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(engine.get(started.id).status, "succeeded");
  } finally {
    await engine.shutdown();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a workflow write creates a missing session directory and the workflows directory", async () => {
  const root = tempRoot("lazy-workflow-");
  const session = join(root, "subagents", "session");
  const workflowsDir = join(session, "workflows");
  const engine = new Workflows(workflowsDir, host());
  try {
    assert.equal(existsSync(session), false);
    const started = engine.start({
      version: 1, name: "test", cwd: root,
      limits: { concurrency: 1, maxAttempts: 5, timeoutSeconds: 30 },
      steps: [{ id: "a", kind: "task", worker, instructions: "a" }],
    }) as { id: string };
    assert.equal(existsSync(session), true);
    assert.equal(existsSync(workflowsDir), true);
    if (process.platform !== "win32") {
      assert.equal(mode(session), 0o700);
      assert.equal(mode(workflowsDir), 0o700);
    }
    for (let n = 0; n < 400 && engine.get(started.id).status === "running"; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(engine.get(started.id).status, "succeeded");
  } finally {
    await engine.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
