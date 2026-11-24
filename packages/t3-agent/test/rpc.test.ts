import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  const tabs = new Set(["reused"]); // Already open before the measured request.
  let scenario, calls;
  pi.on("before_agent_start", event => {
    scenario = event.prompt.startsWith("preview: ") ? event.prompt.slice(9) : undefined;
    calls = 0;
  });
  for (const name of TOOLS) {
    pi.registerTool({
      name: "mcp__t3-code__" + name, label: name, description: "T3 " + name,
      parameters: Type.Object({}, { additionalProperties: true }),
      exposure: DIRECT.includes(name) ? "direct" : "deferred",
      async execute(_id, args) {
        let result = name === "delegate_task" ? { taskId: "node:task-1", status: "running", workState: "working", link: "<t3-thread://v2/e/t1>" } : {};
        if (name === "preview_open") {
          tabs.add(scenario);
          result = { available: true, tabId: scenario, visible: true, url: null, title: null, loading: false,
            control: { owner: "agent", ownedByCaller: true, generation: 1 } };
        } else if (name === "t3_preview_close") tabs.delete(args.tabId);
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
      calls++;
      const call = (name, args) => ({ type: "toolCall", id: "call-" + calls, name: "mcp__t3-code__" + name, arguments: args });
      const reminder = last?.role === "user" && JSON.stringify(last.content).includes("Automated note from the t3-agent extension");
      let reply;
      if (delegate) reply = call("delegate_task", { title: "Review the branch", task: "Check the patch" });
      else if (scenario && calls === 1) reply = call("preview_open", scenario === "reused" ? { tabId: scenario } : { reuseExistingTab: false });
      else if ((scenario === "closed" && calls === 2) || (scenario === "missed" && reminder)) reply = call("t3_preview_close", { tabId: scenario });
      else reply = { type: "text", text: JSON.stringify(scenario ? { calls, tabOpen: tabs.has(scenario) } :
        { system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) }) };
      const content = [reply];
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: reply.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
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

const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../extensions/t3-agent/index.ts", import.meta.url));

test("RPC get_commands discovers the six shortcut templates only with the T3 marker", async t => {
  const dir = await mkdtemp(join(tmpdir(), "t3-agent-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marked = Boolean(process.env.T3_MCP_URL);
  const child = spawnSync(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-extensions",
    "--no-context-files", "-e", extension], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_TELEMETRY: "0",
      ...(marked && { T3_MCP_URL: "http://t3.invalid/mcp" }) },
    input: '{"id":"commands","type":"get_commands"}\n', encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const reply = child.stdout.trim().split("\n").map(line => JSON.parse(line)).find(e => e.id === "commands");
  assert.equal(reply?.success, true);
  const prompts = reply.data.commands.filter((c: { source: string }) => c.source === "prompt");
  assert.deepEqual(prompts.map((c: { name: string }) => c.name).sort(), marked
    ? ["t3-babysit", "t3-chart", "t3-fanout", "t3-handoff", "t3-review", "t3-ship"] : []);
});

test("under a real Pi RPC session the prompt section, loadout and ledger reach the model", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "t3-agent-rpc-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const fixture = join(dir, "fake-t3.ts");
  await writeFile(fixture, FIXTURE);
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

    send({ id: "full", type: "prompt", message: "/t3-agent loadout full" });
    await waitFor(e => e.type === "response" && e.id === "full" && e.success);
    // Count actual streamSimple calls after the first answer, and check the stand-in
    // bridge's tab state (not the extension's own ledger) before and after continuing.
    for (const [scenario, expected] of [
      ["closed", [{ calls: 3, tabOpen: false }]],
      ["reused", [{ calls: 2, tabOpen: true }]],
      ["missed", [{ calls: 2, tabOpen: true }, { calls: 4, tabOpen: false }]],
      ["keep-open", [{ calls: 2, tabOpen: true }, { calls: 3, tabOpen: true }]],
    ] as const) {
      const start = events.length;
      await report(`preview: ${scenario}`);
      const answers = events.slice(start).filter(e => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "stop")
        .map(e => JSON.parse(e.message.content[0].text));
      assert.deepEqual(answers, expected, scenario);
      t.diagnostic(`${scenario}: ${answers.at(-1).calls} provider requests, ${answers.at(-1).calls - answers[0].calls} after the first answer`);
    }
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
