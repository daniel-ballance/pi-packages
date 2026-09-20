import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JsonlDecoder } from "../src/rpc.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/notification-provider.mjs", import.meta.url));

for (const mode of ["read", "unread"]) {
  test(`real parent/child RPC: ${mode === "read" ? "reading suppresses notification" : "unread output triggers exactly one acknowledged report"}`, { timeout: 20000, skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "notice-parent-rpc-"));
    const agentDir = join(root, "agent"), bin = join(root, "bin");
    mkdirSync(agentDir); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "notification-test/stub:off" }], tools: [], extensions: [provider] }));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider, "-e", extension, "--model", "notification-test/stub:off"], {
      cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", NOTICE_TEST_MODE: mode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events: any[] = [];
    let stderr = "";
    const decoder = new JsonlDecoder(packet => events.push(packet));
    child.stdout.setEncoding("utf8"); child.stdout.on("data", text => decoder.push(text));
    child.stderr.on("data", text => { stderr += text; });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const hasText = (text: string) => events.some(e => e.type === "message_end" && e.message?.role === "assistant" && e.message.content?.some((c: any) => c.text === text));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`${stderr}\n${JSON.stringify(events)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      child.stdin.write(JSON.stringify({ type: "prompt", message: "Exercise notification delivery." }) + "\n");
      await waitFor(() => hasText("PARENT FINISHED"));
      if (mode === "unread") await waitFor(() => hasText("REPORT RECEIVED"));
      await new Promise(resolve => setTimeout(resolve, 350));
      const reports = events.filter(e => e.type === "message_end" && e.message?.customType === "subagent-report");
      assert.equal(reports.length, mode === "read" ? 0 : 1, JSON.stringify(events));
      assert.equal(events.filter(e => e.type === "extension_error").length, 0, stderr);
      const parentId = readdirSync(join(agentDir, "subagents"))[0];
      const registry = JSON.parse(readFileSync(join(agentDir, "subagents", parentId, "registry.json"), "utf8"));
      assert.deepEqual(registry.pendingNotices, []);
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
      await closed; clearTimeout(kill);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
