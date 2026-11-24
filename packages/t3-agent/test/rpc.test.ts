import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Stands in for T3's bridge and a model: fake `mcp__t3-code__*` tools with the bridge's
// exposures, and a provider that calls delegate_task once, then reports the system
// prompt and the tools it was given. No credentials, network or T3 server.
const FIXTURE = `
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
const DIRECT = ["orchestrator_capabilities", "delegate_task", "task_status"];
const TOOLS = [...DIRECT, "task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task", "preview_open", "t3_preview_close"];
export default function(pi) {
  for (const name of TOOLS) {
    pi.registerTool({
      name: "mcp__t3-code__" + name, label: name, description: "T3 " + name,
      parameters: Type.Object({}, { additionalProperties: true }),
      exposure: DIRECT.includes(name) ? "direct" : "deferred",
      async execute() {
        const result = name === "delegate_task" ? { taskId: "node:task-1", status: "running", workState: "working", link: "<t3-thread://v2/e/t1>" } : {};
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { server: "t3-code", tool: name } };
      },
    });
  }
  pi.registerProvider("t3-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-responses",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const delegate = last?.role === "user" && JSON.stringify(last.content).includes("delegate");
      const content = delegate
        ? [{ type: "toolCall", id: "call-1", name: "mcp__t3-code__delegate_task", arguments: { title: "Review the branch", task: "Check the patch" } }]
        : [{ type: "text", text: JSON.stringify({ system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) }) }];
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: delegate ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
`;

test("under a real Pi RPC session the prompt section, loadout and ledger reach the model", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-agent-rpc-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const fixture = join(dir, "fake-t3.ts");
  await writeFile(fixture, FIXTURE);
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("../extensions/t3-agent/index.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "-e", fixture, "-e", extension, "--provider", "t3-test", "--model", "fake"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      T3_MCP_URL: "http://t3.invalid/mcp", T3_PI_RUNTIME_MODE: "approval-required" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const waitFor = async (predicate: (event: any) => boolean, after = 0) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const event = events.slice(after).find(predicate);
      if (event) return event;
      assert.equal(child.exitCode, null, stderr);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`timed out; stderr: ${stderr}`);
  };
  const report = async (message: string) => {
    const start = events.length;
    send({ type: "prompt", message });
    await waitFor(event => event.type === "agent_settled", start);
    const reply = events.slice(start).filter(event => event.type === "message_end" && event.message.role === "assistant").at(-1);
    return JSON.parse(reply.message.content[0].text) as { system: string; tools: string[] };
  };

  try {
    const first = await report("status");
    assert.match(first.system, /<t3_agent>\n## Pi under T3 Code/);
    assert.match(first.system, /Permission mode: supervised/);
    assert.match(first.system, /use `delegate_task`: it is your subagent tool/);
    for (const name of ["grep", "find", "ls", "mcp__t3-code__delegate_task", "mcp__t3-code__html_render", "mcp__t3-code__schedule_task"]) {
      assert.ok(first.tools.includes(name), `${name} is declared`);
    }
    assert.ok(!first.tools.includes("mcp__t3-code__preview_open"), "tools outside the loadout stay deferred");
    const status = events.find(event => event.type === "extension_ui_request" && event.method === "setStatus");
    assert.equal(status.statusText, "t3-agent: supervised · standard loadout");

    await report("delegate");
    const second = await report("status again");
    assert.match(second.system, /### Open T3 handles[\s\S]*delegate "Review the branch" taskId=node:task-1, status working/);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
