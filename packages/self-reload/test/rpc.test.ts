import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// A deterministic in-process provider: no credentials or network, but real
// agent/tool execution, RPC transport, extension loading and runtime reload.
function provider(version: string) {
  return `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("reload-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const resumed = context.messages.some(m => m.role === "toolResult" && m.toolName === "self_reload");
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: resumed ? [{ type: "text", text: "continued-${version}" }] : [
          { type: "toolCall", id: "reload-1", name: "self_reload", arguments: { continuation: "Verify the new version.", reason: "Activate provider v2", expectedTools: ["self_reload"] } }
        ],
        stopReason: resumed ? "stop" : "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    }
  });
}
`;
}

test("real RPC agent requests reload and automatically continues using edited code", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-self-reload-"));
  const fixture = join(dir, "provider.ts");
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(fixture, provider("v1"));
  const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
  const extension = fileURLToPath(new URL("../extensions/self-reload/index.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", extension, "-e", fixture,
    "--provider", "reload-test", "--model", "fake"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (command: object) => child.stdin.write(JSON.stringify(command) + "\n");
  async function waitFor(predicate: (event: any) => boolean) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const event = events.find(predicate);
      if (event) return event;
      assert.equal(child.exitCode, null, stderr);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Timed out. stderr=${stderr}\nevents=${JSON.stringify(events)}`);
  }
  try {
    send({ id: "ready", type: "get_commands" });
    const ready = await waitFor(e => e.id === "ready");
    assert.ok(ready.data.commands.some((c: any) => c.name === "self-reload"));
    // v1 is loaded. The disk change must only become effective after reload.
    await writeFile(fixture, provider("v2"));
    send({ id: "run", type: "prompt", message: "Exercise self_reload." });
    await waitFor(e => e.type === "message_end" && e.message?.content?.some?.((c: any) => c.text === "continued-v2"));
    const completions = events.filter(e => e.type === "message_end" && e.message?.customType === "self-reload");
    assert.equal(completions.length, 1);
    assert.match(completions[0].message.content, /Verify the new version/);
    assert.match(completions[0].message.content, /Expected tools are active/);
    assert.equal(completions[0].message.details.status, "reloaded");
    assert.deepEqual(completions[0].message.details.missingTools, []);
    assert.ok(events.some(e => e.type === "extension_ui_request" && e.method === "notify" && e.message.includes("Activate provider v2")));
    assert.ok(events.some(e => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusText === "Reloading Pi resources…"));
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.toolName === "self_reload" && !e.isError));
    assert.equal(events.filter(e => e.type === "extension_error").length, 0, JSON.stringify(events));
    // Reload again to catch leaked completion listeners / duplicate continuations.
    send({ id: "again", type: "prompt", message: "/self-reload Second pass." });
    await waitFor(e => e.type === "message_end" && e.message?.customType === "self-reload" && e.message.content.includes("Second pass."));
    await waitFor(e => e.id === "again");
    assert.equal(events.filter(e => e.type === "message_end" && e.message?.customType === "self-reload").length, 2);
  } finally {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
