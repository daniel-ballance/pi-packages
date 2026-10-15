import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents, { CATALOG_CHANNEL } from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";

test("other extensions read the usable models over the event bus, synchronously", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "catalog-agent-"));
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:high" }, { id: "p/gone:off" }] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Function[]>(), bus = new Map<string, Function>();
  const ctx = {
    cwd: agentDir, mode: "print", hasUI: false, isIdle: () => true, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {} }] },
    ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [] },
  };
  try {
    asHost("cli", () => {
      subagents({
        registerFlag() {}, getFlag() { return false; },
        on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
        registerTool() {}, registerCommand() {}, getAllTools: () => [],
        events: { on: (channel: string, handler: Function) => { bus.set(channel, handler); return () => bus.delete(channel); } },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    let catalog: unknown;
    void bus.get(CATALOG_CHANNEL)!({ reply: (value: unknown) => { catalog = value; } });
    assert.deepEqual(catalog, { spawnEnabled: true, models: ["p/m:high"] }, "only allowed models that are usable now");
    bus.get(CATALOG_CHANNEL)!(undefined); // A malformed request is ignored.
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    assert.equal(bus.has(CATALOG_CHANNEL), false, "unsubscribed at shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
