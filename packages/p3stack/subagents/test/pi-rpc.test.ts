import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { tempRoot } from "./support/temp-root.js";

const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = fileURLToPath(new URL("./fixtures/provider.mjs", import.meta.url));

for (const task of ["slow-codex", "slow-genuine"]) {
  test(`real Pi RPC abort: ${task} emits error stopReason without masking unrelated failures`, { timeout: 15000 }, async () => {
    const dir = tempRoot("subagent-real-abort-");
    const manager = new SubagentManager(join(dir, "manager"));
    try {
      const a = await manager.spawn({
        name: task, task, cwd: dir, executable: process.execPath, executableArgs: [cli],
        env: { PI_CODING_AGENT_DIR: join(dir, "config"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
        model: "subagent-test/stub:off", tools: [],
        cliArgs: ["--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider],
      });
      await manager.abort(a.id);
      await manager.wait([a.id], "all", 5000);
      const result = manager.summary(a.id);
      const cancelled = task === "slow-codex";
      assert.equal(result.status, cancelled ? "idle" : "failed");
      assert.equal(result.aborted, cancelled);
      assert.equal(result.error, cancelled ? undefined : "429 quota exceeded");
      assert.equal(manager.pendingNotices().at(-1)?.kind, cancelled ? "aborted" : "failure");
      // Manager log appends run synchronously on this event loop; take a same-turn
      // snapshot rather than racing an async read's size check with another append.
      const events = readFileSync(result.logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const message = events.find(e => e.type === "message_end" && e.message?.stopReason === "error")?.message;
      assert.ok(message, "fixture must reproduce the real adapter's error stopReason on the RPC wire");
      assert.equal(message.errorMessage, cancelled ? "The operation was aborted." : "429 quota exceeded");
      await manager.send(a.id, "normal follow-up");
      await manager.wait([a.id], "all", 5000);
      assert.equal(manager.summary(a.id).status, "idle");
      assert.equal(manager.summary(a.id).aborted, false);
    } finally { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("real Pi RPC children: parallel prompts, abort, follow-up, shutdown, and persisted resumption", { timeout: 30000 }, async () => {
  const dir = tempRoot("subagent-real-pi-");
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
