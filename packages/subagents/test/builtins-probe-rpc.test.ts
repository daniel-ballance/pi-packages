import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";

// Characterization of Pi itself, separate from the managed-policy regressions.
const executable = process.env.PEER_TEST_EXECUTABLE ?? process.execPath;
const cliArgs = process.env.PEER_TEST_EXECUTABLE ? [] : [fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url))];
const fixture = fileURLToPath(new URL("./fixtures/builtin-probe-provider.mjs", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/builtin-probe-mcp.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/src/child-guard.ts", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const wrapped of [false, true]) {
  test(`Pi 0.99 built-in characterization: ${wrapped ? "configured factories" : "stock built-ins"}`, {
    timeout: 30000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "builtin-probe-")), agentDir = join(root, "agent");
    mkdirSync(agentDir); mkdirSync(join(root, ".pi"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ codemode: { mode: "on", inlineBudget: 77 }, cacheWarming: "idle" }));
    writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ codemode: { mode: "only", inlineBudget: 99 }, cacheWarming: "off" }));
    const globalMarker = join(root, "global-started"), projectMarker = join(root, "project-started");
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { global: { command: process.execPath, args: [server, globalMarker] } } }));
    writeFileSync(join(root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { project: { command: process.execPath, args: [server, projectMarker] } } }));
    const events: Packet[] = []; let stderr = "";
    const child = new RpcChild({ executable: executable!, cwd: root,
      args: [...cliArgs, "--offline", "--mode", "rpc", "--session", join(root, "session.jsonl"), "--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--approve",
        "--model", "builtin-probe/stub:off", "--tools", "codemode,tool_search,metered,forbidden,subagent_forbidden",
        "-e", "builtin:codemode", "-e", "builtin:tool-search", "-e", "builtin:mcp", "-e", fixture, "-e", guard],
      // Do not forward the developer's provider credentials or real agent directory.
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
        PI_SUBAGENT: "1", PI_SUBAGENT_ALLOWED_TOOLS: JSON.stringify(["codemode", "tool_search", "metered"]), BUILTIN_PROBE_WRAPPED: wrapped ? "1" : "0" },
      event: event => events.push(event), stderr: text => { stderr += text; }, exit: () => {},
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) { assert.ok(Date.now() < deadline, `${stderr}\n${JSON.stringify(events.slice(-8))}`); await sleep(10); }
    };
    const run = async (message: string) => {
      const start = events.length;
      const response = await child.request({ type: "prompt", message });
      await waitFor(() => events.slice(start).some(event => event.type === "agent_settled"));
      assert.deepEqual(response, { disposition: "started" });
      return events.slice(start);
    };
    try {
      const state = await child.request({ type: "get_state" });
      assert.equal(state.model.provider, "builtin-probe");
      assert.equal(state.model.id, "stub");
      assert.equal(state.sessionFile, join(root, "session.jsonl"));
      await child.request({ type: "prompt", message: "/builtin-probe" });
      const initial = events.find(event => event.entry?.customType === "builtin-probe")?.entry.data;
      assert.ok(initial, stderr);
      assert.equal(initial.virtual.api, "pi-virtual");
      assert.deepEqual(initial.settings.codemode, { mode: "only", inlineBudget: 99 });
      assert.equal(initial.settings.cacheWarming, "off"); // Not evidence of the global-only warming mode.
      if (!wrapped) {
        assert.equal(initial.tools.find((tool: Packet) => tool.name === "codemode").sourceInfo.path, "builtin:codemode");
        await waitFor(() => existsSync(globalMarker) && existsSync(projectMarker));
      }
      const blocked = await run('CODE for (const name of ["forbidden", "subagent_forbidden"]) { try { await tools[name]({}); } catch (error) { text(error.message); } }');
      for (const name of ["forbidden", "subagent_forbidden"]) {
        const call = blocked.find(event => event.entry?.customType === "builtin-probe-call" && event.entry.data.name === name);
        assert.ok(call?.entry.data.parent);
        const result = blocked.find(event => event.type === "tool_execution_end" && event.toolName === name);
        assert.equal(result?.isError, true);
        assert.match(result?.result.content[0].text, /excluded by managed child policy/);
      }
      const search = await run("SEARCH");
      assert.deepEqual(search.find(event => event.type === "tool_execution_end" && event.toolName === "tool_search")?.result.details.loaded, ["forbidden"]);
      const metered = await run('CODE text(typeof models); if (typeof models !== "undefined") text(await models.classify(await models.getModelOfType("classifier", "builtin-probe", "classifier"), {state:{},questions:{}})); await tools.metered({});');
      const output = metered.find(event => event.type === "tool_execution_end" && event.toolName === "codemode")?.result.content;
      assert.ok(output.some((block: Packet) => block.text === (wrapped ? "undefined" : "object")));
      const calls = metered.filter(event => event.entry?.customType === "builtin-probe-call").map(event => event.entry.data.name);
      assert.deepEqual(calls, ["codemode", "metered"], "classifier does not emit a tool_call");
      const stats = await child.request({ type: "get_session_stats" });
      assert.equal(stats.cost, wrapped ? 0.5 : 0.75, "authoritative cumulative usage includes nested/classifier usage once");
      for (const type of ["prompt", "steer", "follow_up"]) {
        assert.deepEqual(await child.request({ type, message: "CONSUME" }), { disposition: "handled" });
      }
      for (const type of ["steer", "follow_up"]) {
        assert.deepEqual(await child.request({ type, message: "queued" }), { disposition: "queued" });
      }
      await child.request({ type: "clear_queue" });
      await child.request({ type: "prompt", message: "/builtin-probe" });
      const final = events.findLast(event => event.entry?.customType === "builtin-probe")?.entry.data;
      assert.ok(!final.active.includes("forbidden"));
      assert.equal(existsSync(globalMarker), !wrapped);
      assert.equal(existsSync(projectMarker), !wrapped);
      assert.equal(events.some(event => event.type === "extension_error"), false, stderr);
    } finally { await child.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}
