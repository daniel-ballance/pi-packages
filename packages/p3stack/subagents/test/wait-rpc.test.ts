import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JsonlDecoder } from "../extensions/subagents/src/rpc.js";
import { tempRoot } from "./support/temp-root.js";
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/notification-provider.mjs", import.meta.url));
const executable = process.env.PEER_TEST_EXECUTABLE ?? process.execPath;
const executableArgs = process.env.PEER_TEST_EXECUTABLE ? [] : [cli];

for (const mode of ["message", "abort"] as const) {
  test(`real parent RPC: ${mode === "message" ? "a steer typed during an unbounded wait ends it" : "aborting an unbounded wait leaves the worker running"}`, { timeout: 20000, skip: process.platform === "win32" }, async () => {
    const root = tempRoot("wait-parent-rpc-");
    const agentDir = join(root, "agent"), bin = join(root, "bin");
    mkdirSync(agentDir); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${[executable, ...executableArgs].map(arg => JSON.stringify(arg)).join(" ")} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "notification-test/stub:off" }], tools: [], extensions: [provider] }));
    const child = spawn(executable, [...executableArgs, "--mode", "rpc", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider, "-e", extension, "--model", "notification-test/stub:off"], {
      cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", NOTICE_TEST_MODE: mode, NOTICE_TEST_RELEASE: join(root, "release") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events: any[] = [];
    let stderr = "";
    const decoder = new JsonlDecoder(packet => events.push(packet));
    child.stdout.setEncoding("utf8"); child.stdout.on("data", text => decoder.push(text));
    child.stderr.on("data", text => { stderr += text; });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const waitFor = async <T>(find: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + 10000;
      for (let found = find(); ; found = find()) {
        if (found !== undefined) return found;
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`${stderr}\n${JSON.stringify(events)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const waitEvent = (type: string) => waitFor(() => events.find(event => event.type === type && event.toolName === "subagent_wait"));
    try {
      child.stdin.write(JSON.stringify({ type: "prompt", message: "Exercise an unbounded wait." }) + "\n");
      await waitEvent("tool_execution_start");
      child.stdin.write(JSON.stringify(mode === "message"
        ? { type: "prompt", message: "Operator steer.", streamingBehavior: "steer" }
        : { type: "abort" }) + "\n");
      const ended = await waitEvent("tool_execution_end");
      const workerStatus = () => JSON.parse(readFileSync(join(agentDir, "subagents", readdirSync(join(agentDir, "subagents"))[0], "registry.json"), "utf8")).agents[0].status;
      assert.equal(workerStatus(), "working", "the worker keeps working until the test releases it");
      if (mode === "message") {
        assert.equal(ended.isError, false, JSON.stringify(ended));
        assert.equal(ended.result.details.wake, "message");
      } else assert.equal(ended.isError, true, JSON.stringify(ended));
      writeFileSync(join(root, "release"), "");
      await waitFor(() => workerStatus() === "working" ? undefined : true);
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
      await closed; clearTimeout(kill);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
