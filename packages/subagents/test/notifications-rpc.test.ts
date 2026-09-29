import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JsonlDecoder } from "../extensions/subagents/src/rpc.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/notification-provider.mjs", import.meta.url));
const executable = process.env.PEER_TEST_EXECUTABLE ?? process.execPath;
const executableArgs = process.env.PEER_TEST_EXECUTABLE ? [] : [cli];

for (const mode of ["read", "collect", "unread", "halt", "kill"]) {
  test(`real parent/child RPC notification: ${mode}`,  { timeout: 20000, skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "notice-parent-rpc-"));
    const agentDir = join(root, "agent"), bin = join(root, "bin");
    mkdirSync(agentDir); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${[executable, ...executableArgs].map(arg => JSON.stringify(arg)).join(" ")} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "notification-test/stub:off" }], tools: [], extensions: [provider] }));
    const child = spawn(executable, [...executableArgs, "--mode", "rpc", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider, "-e", extension, "--model", "notification-test/stub:off"], {
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
      if (mode === "halt" || mode === "kill") {
        const parentId = readdirSync(join(agentDir, "subagents"))[0];
        const registryPath = join(agentDir, "subagents", parentId, "registry.json");
        const before = JSON.parse(readFileSync(registryPath, "utf8"));
        const worker = before.agents[0];
        child.stdin.write(JSON.stringify({ type: "prompt", message: `/subagents ${mode} ${worker.id}` }) + "\n");
        if (mode === "kill") {
          await waitFor(() => events.some(e => e.type === "extension_ui_request" && e.method === "confirm"));
          const confirmation = events.find(e => e.type === "extension_ui_request" && e.method === "confirm");
          child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: confirmation.id, confirmed: true }) + "\n");
        }
        await waitFor(() => hasText("REPORT RECEIVED"));
        await waitFor(() => JSON.parse(readFileSync(registryPath, "utf8")).agents[0].hold?.outcome === "confirmed");
        const after = JSON.parse(readFileSync(registryPath, "utf8"));
        assert.equal(after.agents[0].hold.kind, mode);
        assert.equal(after.agents[0].hold.outcome, "confirmed");
        assert.equal(after.agents[0].status, mode === "kill" ? "stopped" : "idle");
      } else if (mode === "unread") await waitFor(() => hasText("REPORT RECEIVED"));
      await new Promise(resolve => setTimeout(resolve, 350));
      const reports = events.filter(e => e.type === "message_end" && e.message?.customType === "subagent-report");
      if (["halt", "kill"].includes(mode)) {
        assert.ok(reports.length >= 1 && reports.length <= 2, JSON.stringify(events));
        assert.match(reports.map(report => report.message.content).join("\n"), /confirmed/);
      } else assert.equal(reports.length, ["read", "collect"].includes(mode) ? 0 : 1, JSON.stringify(events));
      if (mode === "halt" || mode === "kill") assert.match(reports[0].message.content, /HUMAN SUPERVISION/);
      assert.equal(events.filter(e => e.type === "extension_error").length, 0, stderr);
      const parentId = readdirSync(join(agentDir, "subagents"))[0];
      const registry = JSON.parse(readFileSync(join(agentDir, "subagents", parentId, "registry.json"), "utf8"));
      assert.deepEqual(registry.pendingNotices, []);
      assert.deepEqual(registry.agents[0].config.coordination, { owns: [join(root, "src")], outputs: [join(root, "report.md")] });
      if (mode === "collect") assert.equal(registry.agents[0].resultReview.status, "reviewed");
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
      await closed; clearTimeout(kill);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
