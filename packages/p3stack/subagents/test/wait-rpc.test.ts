import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
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

type PairMode = "pair" | "all" | "steer" | "followUp";

async function withPairParent(mode: PairMode, run: (session: {
  events: any[];
  until: (ready: () => boolean, label: string) => Promise<void>;
  release: (which: "first" | "second") => void;
  agents: () => { name: string; status: string }[];
  send: (message: string, streamingBehavior: "steer" | "followUp") => void;
}) => Promise<void>) {
  const root = tempRoot("wait-pair-rpc-");
  const agentDir = join(root, "agent"), bin = join(root, "bin");
  mkdirSync(agentDir); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${[executable, ...executableArgs].map(arg => JSON.stringify(arg)).join(" ")} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "notification-test/stub:off" }], tools: [], extensions: [provider] }));
  const child = spawn(executable, [...executableArgs, "--mode", "rpc", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "-e", provider, "-e", extension, "--model", "notification-test/stub:off"], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      NOTICE_TEST_MODE: mode, WAIT_RELEASE_FIRST: join(root, "release-first"), WAIT_RELEASE_SECOND: join(root, "release-second"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let stderr = "";
  const decoder = new JsonlDecoder(packet => events.push(packet));
  child.stdout.setEncoding("utf8"); child.stdout.on("data", text => decoder.push(text));
  child.stderr.on("data", text => { stderr += text; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const until = async (ready: () => boolean, label: string) => {
    const deadline = Date.now() + 12000;
    while (!ready()) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`${label}\n${stderr}\n${JSON.stringify(events)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const agents = () => {
    const sessions = readdirSync(join(agentDir, "subagents"));
    return JSON.parse(readFileSync(join(agentDir, "subagents", sessions[0], "registry.json"), "utf8")).agents as { name: string; status: string }[];
  };
  try {
    child.stdin.write(JSON.stringify({ type: "prompt", message: "Wait for both workers." }) + "\n");
    await run({
      events, until, agents,
      release: which => writeFileSync(join(root, `release-${which}`), ""),
      send: (message, streamingBehavior) => child.stdin.write(JSON.stringify({ type: "prompt", message, streamingBehavior }) + "\n"),
    });
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
    await closed; clearTimeout(kill);
    rmSync(root, { recursive: true, force: true });
  }
}

const waitEnd = (events: any[]) => events.find(event => event.type === "tool_execution_end" && event.toolName === "subagent_wait");
const bothWorking = (agents: { status: string }[]) => agents.filter(agent => agent.status === "working").length === 2;

describe("real parent RPC multi-child wait", { concurrency: 1, skip: process.platform === "win32" }, () => {
  test("an omitted wait returns the first child's result while the second is still working", { timeout: 20000 }, async () => {
    await withPairParent("pair", async ({ events, until, release, agents }) => {
      await until(() => events.some(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait"), "wait start");
      const start = events.find(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait");
      assert.equal(start.args.mode, undefined, JSON.stringify(start.args));
      assert.equal(start.args.ids.length, 2);
      await until(() => bothWorking(agents()), "both working");
      release("first");
      await until(() => agents().find(agent => agent.name === "first")?.status === "idle", "first settled");
      await until(() => waitEnd(events), "wait end");
      const ended = waitEnd(events);
      assert.equal(ended.isError, false, JSON.stringify(ended));
      assert.equal(ended.result.details.wake, "settled", JSON.stringify(ended.result));
      assert.match(JSON.stringify(ended.result), /first result/);
      assert.doesNotMatch(JSON.stringify(ended.result), /second result/);
      assert.equal(agents().find(agent => agent.name === "second")?.status, "working");
      release("second");
      await until(() => agents().find(agent => agent.name === "second")?.status === "idle", "second released");
    });
  });

  test("explicit all waits until the second child settles", { timeout: 20000 }, async () => {
    await withPairParent("all", async ({ events, until, release, agents }) => {
      await until(() => events.some(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait"), "wait start");
      const start = events.find(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait");
      assert.equal(start.args.mode, "all", JSON.stringify(start.args));
      await until(() => bothWorking(agents()), "both working");
      release("first");
      await until(() => agents().find(agent => agent.name === "first")?.status === "idle", "first settled");
      const observed = Date.now();
      while (Date.now() - observed < 1000) {
        if (waitEnd(events)) assert.fail(`explicit all returned before the second child was released\n${JSON.stringify(waitEnd(events))}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      release("second");
      await until(() => waitEnd(events), "wait end");
      const ended = waitEnd(events);
      assert.equal(ended.result.details.wake, "settled", JSON.stringify(ended.result));
      assert.match(JSON.stringify(ended.result), /first result/);
      assert.match(JSON.stringify(ended.result), /second result/);
      assert.equal(agents().every(agent => agent.status === "idle"), true, JSON.stringify(agents()));
    });
  });

  for (const behavior of ["steer", "followUp"] as const) {
    test(`${behavior} during a multi-child wait ends it and leaves both children working`, { timeout: 20000 }, async () => {
      await withPairParent(behavior, async ({ events, until, release, agents, send }) => {
        await until(() => events.some(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait"), "wait start");
        assert.equal(events.find(event => event.type === "tool_execution_start" && event.toolName === "subagent_wait").args.mode, undefined);
        await until(() => bothWorking(agents()), "both working");
        const prompts = () => events.filter(event => event.type === "response" && event.command === "prompt").length;
        const before = prompts();
        send("Operator steer.", behavior);
        await until(() => prompts() > before, "prompt accepted");
        const accepted = events.filter(event => event.type === "response" && event.command === "prompt").at(-1);
        assert.equal(accepted.success, true, JSON.stringify(accepted));
        await until(() => waitEnd(events), "wait end");
        const ended = waitEnd(events);
        assert.equal(ended.isError, false, JSON.stringify(ended));
        assert.equal(ended.result.details.wake, "message", JSON.stringify(ended.result));
        assert.equal(bothWorking(agents()), true, JSON.stringify(agents()));
        release("first"); release("second");
        await until(() => agents().every(agent => agent.status === "idle"), "both released");
      });
    });
  }
});
