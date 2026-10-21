import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createAgentSession, createEventBus, DefaultResourceLoader, FooterComponent, initTheme, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import subagents from "../extensions/subagents/index.js";
import { decorateFooter } from "../extensions/subagents/src/footer.js";
import { SubagentManager, type AgentRecord } from "../extensions/subagents/src/manager.js";

test("the mode footer keeps the live subagents summary right aligned, with the stock narrow fallback", async () => {
  const { registerMode } = await import(new URL("../../extensions/p3stack/src/mode.ts", import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "mode-footer-"));
  const previous = process.env.PI_CODING_AGENT_DIR, previousHost = process.env.T3_MCP_URL;
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.T3_MCP_URL;
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
  const events = createEventBus();
  const footers: Parameters<ExtensionUIContext["setFooter"]>[0][] = [];
  const pi = {
    registerFlag() {}, getFlag: () => false, registerTool() {}, getAllTools: () => [], getCommands: () => [],
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    events,
  };
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(root);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager, settingsManager, resourceLoader });
  const records = [{ status: "working", usage: { cost: 0.123 } }, { status: "stopped", usage: { cost: 0 } }, { status: "stopped", usage: { cost: 0 } }];
  const list = mock.method(SubagentManager.prototype, "list", () => records as AgentRecord[]);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => false,
    sessionManager, modelRegistry: { getAvailable: () => [] }, getContextUsage: () => undefined,
    ui: { setFooter: (footer: Parameters<ExtensionUIContext["setFooter"]>[0]) => footers.push(footer), setStatus() {}, notify() {} },
  };
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
  try {
    initTheme("dark", false);
    const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    Object.assign(ctx.ui, { theme });
    const data = { getGitBranch: () => "footer-test", getExtensionStatuses: () => new Map<string, string>(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
    registerMode(pi, "router.md");
    subagents(pi as unknown as ExtensionAPI);
    await commands.get("p3stack").handler("on", ctx);
    const footer = footers.at(-1)!(new TuiMainScreen(new ProcessTerminal()), theme, data);
    const widths = [200, 80, 40, 10, 3, 1];
    const bare = new Map(widths.map(width => [width, footer.render(width)]));
    const stock = new FooterComponent(session, data);
    await emit("session_start");
    for (const label of ["subagents: 1/6 of 3 • $0.123", "subagents: 0/6 of 3 • $0.456", ""]) {
      for (const width of widths) {
        const actual = footer.render(width);
        assert.deepEqual(actual, decorateFooter(bare.get(width)!, width, label, text => theme.fg("dim", text)), `live mode footer at width ${width}, label ${JSON.stringify(label)}`);
        assert.ok(actual.every(line => visibleWidth(line) <= width));
        if (label && width === 200) {
          assert.ok(stripTerminalSequences(actual[0]!).endsWith(label));
          assert.equal(visibleWidth(actual[0]!), width);
          assert.ok(stripTerminalSequences(stock.render(width)[0]!).endsWith(label), "stock footer still shows the same label");
        }
        if (label && width === 40) {
          assert.equal(actual.length, 3, "the label gets its own row on narrow terminals");
          assert.equal(actual[0], bare.get(width)![0], "directory and branch stay intact");
          assert.equal(actual[2], bare.get(width)![1], "stats stay below the label");
        }
      }
      records[0] = { status: "stopped", usage: { cost: 0.456 } };
      if (label.includes("0/6")) records.length = 0;
      await emit("session_start");
    }
    await emit("session_shutdown");
    for (const width of widths) assert.deepEqual(footer.render(width), bare.get(width), "shutdown removes the decoration");
    footer.dispose?.();
  } finally {
    await emit("session_shutdown");
    list.mock.restore();
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousHost === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previousHost;
    rmSync(root, { recursive: true, force: true });
  }
});
