import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager } from "../src/manager.js";

const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.mjs", import.meta.url));

test("real Pi RPC children: parallel prompts, abort, follow-up, shutdown, and persisted resumption", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-real-pi-"));
  const env = { PI_CODING_AGENT_DIR: join(dir, "config"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const manager = new SubagentManager(join(dir, "manager"));
  let restored: SubagentManager | undefined;
  try {
    const config = {
      cwd: dir, executable: process.execPath, executableArgs: [cli], env,
      model: "subagent-test/stub:off", tools: [],
      cliArgs: ["--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider],
    };
    const [a, b] = await Promise.all([
      manager.spawn({ ...config, name: "memory", task: "Remember kiwi\u2028fruit." }),
      manager.spawn({ ...config, name: "cancel", task: "slow" }),
    ]);
    assert.equal(a.model, "subagent-test/stub");
    assert.equal(b.thinking, "off");
    await manager.wait([a.id], "all", 5000);
    assert.ok(manager.read(a.id).updates.some(u => u.text.includes("kiwi\u2028fruit")));
    await manager.abort(b.id);
    assert.equal(manager.get(b.id).status, "idle");
    assert.equal(manager.get(b.id).aborted, true);
    await manager.send(a.id, "What did I say?");
    await manager.wait([a.id], "all", 5000);
    assert.ok(manager.read(a.id).updates.some(u => u.text.startsWith("History (2):")));
    await manager.shutdown();
    restored = new SubagentManager(join(dir, "manager"));
    await restored.resume(a.id, "Still remember?", env);
    await restored.wait([a.id], "all", 5000);
    assert.ok(restored.read(a.id).updates.some(u => u.text.startsWith("History (3):") && u.text.includes("kiwi")));
  } finally {
    await restored?.shutdown(); await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
