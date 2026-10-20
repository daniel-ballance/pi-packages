// Opt-in: HERDR_E2E=1 with herdr and a real `pi` executable on PATH (or
// HERDR_E2E_PI). herdr detects agents by process name, so the dev-dependency
// CLI under node cannot stand in for `pi`. Each test drives a real Pi TUI in a
// pane of a throwaway herdr session, with herdr's own Pi integration, this
// package, real child processes and scripted offline models.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { tempRoot } from "./support/temp-root.js";

const enabled = process.env.HERDR_E2E === "1" && process.platform !== "win32";
const skip = enabled ? false : "set HERDR_E2E=1 (requires herdr and pi on PATH)";
const PI = process.env.HERDR_E2E_PI ?? "pi";
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const EXTENSION = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));
const SESSION = `subagents-herdr-e2e-${process.pid}`;
const SOCKET = join(homedir(), ".config/herdr/sessions", SESSION, "herdr.sock");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const herdr = (...args: string[]) => execFileSync("herdr", ["--session", SESSION, ...args], { encoding: "utf8" });

type Snapshot = { status?: string; agent?: string; label?: string; token?: string; session?: string };
type Sample = Snapshot & { t: number; key: string };
let root = "", proxy: Server | undefined;
const requests: { id: string }[] = [];
/** Requests this package sent; Pi reaches herdr through a logging proxy. */
const ours = () => requests.filter(request => String(request.id).startsWith("pi-subagents:")).length;

function api(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method} timed out`)); }, 3000);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: `e2e:${method}`, method, params })}\n`));
    socket.on("data", data => {
      buffer += data;
      if (buffer.includes("\n")) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0])); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

/** Pi agent directory holding herdr's current Pi integration and a child-only policy. */
function agentDir(name: string, integration = true) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (integration) execFileSync("herdr", ["integration", "install", "pi"], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: "ignore" });
  const child = fixture("herdr-child-provider.mjs");
  writeFileSync(join(dir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "herdr-e2e-child/stub:off" }], tools: [],
    extensions: [child], alwaysExtensions: [child], maxChildren: 4, workingDirectories: [root] }));
  return dir;
}

class Pane {
  id = ""; timeline: Sample[] = []; now: Snapshot = {};
  private poller?: NodeJS.Timeout;
  readonly log: string;
  constructor(readonly name: string, readonly dir: string) { this.log = join(root, `${name}.log`); writeFileSync(this.log, ""); }
  async open() {
    const created = await api("workspace.create", { cwd: root, label: this.name, focus: false });
    this.id = created.result.root_pane.pane_id;
    this.poller = setInterval(() => void this.sample().catch(() => {}), 100);
    return this;
  }
  async sample() {
    const pane = (await api("pane.get", { pane_id: this.id })).result?.pane ?? {};
    const snapshot: Snapshot = { status: pane.agent_status, agent: pane.agent, label: pane.state_labels?.working,
      token: pane.tokens?.subagents, session: pane.agent_session?.source };
    const key = JSON.stringify(snapshot);
    if (this.timeline.at(-1)?.key !== key) this.timeline.push({ t: Date.now(), key, ...snapshot });
    return this.now = snapshot;
  }
  async send(text: string) { herdr("pane", "send-text", this.id, text); await sleep(150); herdr("pane", "send-keys", this.id, "enter"); }
  async launch(extra = "") {
    const starts = this.count("session_start");
    // env -i: no credentials or user configuration can reach a real model.
    const env = [`HOME=${join(root, "home")}`, `PATH=${process.env.PATH}`, "TERM=xterm-256color",
      "HERDR_ENV=$HERDR_ENV", `HERDR_SOCKET_PATH=${join(root, "proxy.sock")}`, "HERDR_PANE_ID=$HERDR_PANE_ID",
      `PI_CODING_AGENT_DIR=${this.dir}`, "PI_OFFLINE=1", `HERDR_E2E_ROOT=${root}`, `HERDR_E2E_LOG=${this.log}`,
      `HERDR_E2E_WORKFLOW=${join(root, "workflow.json")}`];
    await this.send(`env -i ${env.join(" ")} ${PI} --offline --no-skills --no-context-files --no-prompt-templates --no-themes ` +
      `-e ${EXTENSION} -e ${fixture("herdr-parent-provider.mjs")} -e ${fixture("herdr-child-provider.mjs")} ` +
      `-e ${fixture("herdr-control.mjs")} --model herdr-e2e-parent/stub ${extra}`);
    await this.until(() => this.count("session_start") > starts, 20000, "pi session_start");
  }
  lifecycle() { return readFileSync(this.log, "utf8").split("\n").filter(Boolean); }
  count(word: string) { return this.lifecycle().filter(line => line.includes(word)).length; }
  async until(predicate: (snapshot: Snapshot) => boolean, timeout: number, what: string) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(50)) {
      const snapshot = await this.sample().catch(() => this.now);
      if (predicate(snapshot)) return snapshot;
    }
    throw new Error(`Timed out waiting for ${what}. Now ${JSON.stringify(this.now)}\n${this.report()}`);
  }
  report() {
    let screen = "";
    try { screen = herdr("pane", "read", this.id).split("\n").filter(line => line.trim()).slice(-15).join("\n"); } catch {}
    return `timeline: ${JSON.stringify(this.timeline.map(({ key, ...sample }) => sample))}\nlifecycle: ${this.lifecycle().join(" | ")}\nscreen:\n${screen}`;
  }
  /** While a subagent label is shown, the pane must not look settled. */
  assertNoGap(from: number, to: number) {
    const gaps = this.timeline.filter(s => s.t >= from && s.t <= to && s.label && s.status !== "working" && s.status !== "blocked")
      // The final idle report precedes its label-clearing metadata by a few ms.
      .filter(s => !this.timeline.some(next => next.t > s.t && next.t - s.t < 500 && !next.label));
    assert.deepEqual(gaps, [], `pane looked settled while subagents ran\n${this.report()}`);
  }
  async close() {
    clearInterval(this.poller);
    try { await this.send("/quit"); await sleep(1000); } catch {}
    try { await api("workspace.close", { workspace_id: this.id.split(":")[0] }); } catch {}
  }
}

const settled = (s: Snapshot) => s.status === "idle" || s.status === "done";
async function withPane(name: string, run: (pane: Pane) => Promise<void>, options: { integration?: boolean } = {}) {
  const pane = await new Pane(name, agentDir(name, options.integration)).open();
  try { await run(pane); } finally { await pane.close(); }
}
async function idlePane(pane: Pane, extra = "") {
  await pane.launch(extra);
  await pane.until(s => s.status === "idle", 10000, "idle parent");
}
/** Waits from the first label until the label clears, returning the window. */
async function activeWindow(pane: Pane, first: string, timeout = 20000) {
  await pane.until(s => s.label === first, 10000, `label ${first}`);
  const from = Date.now();
  await pane.until(s => !s.label && !s.token, timeout, "labels cleared");
  return { from, to: Date.now() };
}

before(async () => {
  if (!enabled) return;
  root = tempRoot("subagents-herdr-e2e-");
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "workflow.json"), JSON.stringify({ version: 1, name: "e2e workflow", cwd: root,
    limits: { concurrency: 1, maxAttempts: 2, timeoutSeconds: 60 },
    steps: [{ id: "slow", kind: "task", worker: { model: "herdr-e2e-child/stub:off", tools: [] }, instructions: "sleep:5000" }] }));
  spawn("herdr", ["--session", SESSION, "server"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 100 && !existsSync(SOCKET); i++) await sleep(100);
  proxy = createServer(client => {
    const upstream = createConnection(SOCKET); let buffer = "";
    client.on("data", data => {
      buffer += data;
      for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
        try { requests.push(JSON.parse(buffer.slice(0, i))); } catch {}
      }
    });
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>(resolve => proxy!.listen(join(root, "proxy.sock"), resolve));
});

after(async () => {
  if (!enabled) return;
  proxy?.close();
  try { herdr("server", "stop"); } catch {}
  await sleep(500);
  try { execFileSync("herdr", ["session", "delete", SESSION], { stdio: "ignore" }); } catch {}
  rmSync(root, { recursive: true, force: true });
});

test("without subagents, herdr's integration alone drives the pane", { skip, timeout: 60000 }, () => withPane("baseline", async pane => {
  await pane.launch();
  await pane.until(s => s.status === "idle" && s.session === "herdr:pi", 10000, "integration idle");
  await pane.send("TURN 1500");
  await pane.until(s => s.status === "working", 5000, "integration working");
  await pane.until(settled, 8000, "integration settles");
  assert.equal(ours(), 0);
  assert.ok(pane.timeline.every(s => !s.label && !s.token));
}));

test("a child outliving its settled parent keeps the pane working", { skip, timeout: 60000 }, () => withPane("one-child", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 5000");
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  const from = Date.now();
  await pane.until(() => pane.count("agent_settled idle=true") >= 1, 5000, "parent settled");
  assert.deepEqual([pane.now.status, pane.now.label], ["working", "1 subagent"]);
  await pane.until(s => !s.label && !s.token, 15000, "labels cleared");
  pane.assertNoGap(from, Date.now());
  await pane.until(() => pane.count("agent_settled idle=true") >= 2, 10000, "report turn");
  await pane.until(settled, 10000, "final settle");
  assert.equal(pane.now.session, "herdr:pi", "session anchor kept");
}));

test("staggered children count down without a gap", { skip, timeout: 60000 }, () => withPane("staggered", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 3000 7000");
  await pane.until(s => s.label === "2 subagents", 10000, "2 subagents");
  const from = Date.now();
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  await pane.until(s => !s.label, 15000, "labels cleared");
  pane.assertNoGap(from, Date.now());
  await pane.until(settled, 10000, "final settle");
}));

test("parent turns are mirrored while engaged", { skip, timeout: 60000 }, () => withPane("parent-turn", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 9000");
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  const from = Date.now();
  await pane.send("TURN 2500");
  await pane.until(s => s.label === "working + 1 subagent", 5000, "working + 1 subagent");
  await pane.until(s => s.label === "1 subagent", 6000, "parent turn ended");
  await pane.until(s => !s.label, 15000, "labels cleared");
  pane.assertNoGap(from, Date.now());
  await pane.until(settled, 10000, "final settle");
}));

test("herdr:blocked events are mirrored while engaged", { skip, timeout: 60000 }, () => withPane("blocked", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 9000");
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  await pane.send("/blocked on");
  await pane.until(s => s.status === "blocked", 5000, "blocked");
  await pane.send("/blocked off");
  await pane.until(s => s.status === "working" && s.label === "1 subagent", 5000, "unblocked");
  await pane.until(s => !s.label, 15000, "labels cleared");
  await pane.until(settled, 10000, "final settle");
}));

test("a failed child stops counting", { skip, timeout: 60000 }, () => withPane("child-fails", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN fail:3000 6000");
  await pane.until(s => s.label === "2 subagents", 10000, "2 subagents");
  const from = Date.now();
  await pane.until(s => s.label === "1 subagent", 10000, "failed child dropped");
  await pane.until(s => !s.label && !s.token, 15000, "labels cleared");
  pane.assertNoGap(from, Date.now());
  await pane.until(settled, 10000, "final settle");
}));

test("workflows count alongside their workers", { skip, timeout: 60000 }, () => withPane("workflow", async pane => {
  await idlePane(pane);
  await pane.send("WORKFLOW");
  await pane.until(s => /workflow/.test(s.label ?? ""), 10000, "workflow label");
  const from = Date.now();
  await pane.until(s => !s.label, 30000, "labels cleared");
  pane.assertNoGap(from, Date.now());
  assert.ok(pane.timeline.some(s => s.label === "1 subagent, 1 workflow"));
  await pane.until(settled, 10000, "final settle");
}));

test("/reload hands the pane back to the integration without stale labels", { skip, timeout: 60000 }, () => withPane("reload", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 20000");
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  await pane.send("/reload");
  await pane.until(() => pane.count("session_start reload") >= 1, 15000, "reload");
  await pane.until(settled, 8000, "integration settles the pane");
  await sleep(1000);
  const after = await pane.sample();
  assert.ok(!after.label && !after.token, `stale label: ${JSON.stringify(after)}`);
  await pane.send("TURN 1500");
  const working = await pane.until(s => s.status === "working", 5000, "integration working");
  assert.ok(!working.label);
  await pane.until(settled, 8000, "settles");
}));

test("quitting mid-child leaves no token for the next Pi", { skip, timeout: 60000 }, () => withPane("quit", async pane => {
  await idlePane(pane);
  await pane.send("SPAWN 20000");
  await pane.until(s => s.label === "1 subagent", 10000, "1 subagent");
  await pane.send("/quit");
  await pane.until(s => s.agent !== "pi" || s.status === "unknown", 15000, "pi exits");
  await idlePane(pane);
  await pane.send("TURN 1500");
  const working = await pane.until(s => s.status === "working", 5000, "working");
  assert.ok(!working.label && !working.token, `stale: ${JSON.stringify(working)}`);
  await pane.until(settled, 8000, "settles");
}));

test("RPC parents and the opt-out flag send nothing", { skip, timeout: 60000 }, async () => {
  const before = ours();
  await withPane("rpc", async pane => {
    await pane.launch("--mode rpc");
    await pane.send(JSON.stringify({ type: "prompt", message: "SPAWN 2000" }));
    await pane.until(() => pane.count("agent_settled idle=true") >= 2, 20000, "spawn and report turns");
  });
  await withPane("opt-out", async pane => {
    await idlePane(pane, "--disable-native-subagents");
    await pane.send("TURN 1000");
    await pane.until(s => s.status === "working", 5000, "working");
    await pane.until(settled, 8000, "settles");
  });
  assert.equal(ours(), before);
});

test("without the integration, reports are ignored and leave nothing behind", { skip, timeout: 60000 }, () => withPane("no-integration", async pane => {
  await pane.launch();
  await pane.send("SPAWN 3000");
  await pane.until(() => pane.count("agent_settled idle=true") >= 2, 20000, "spawn and report turns");
  await sleep(500);
  await pane.sample();
  assert.ok(!pane.timeline.some(s => s.session === "herdr:pi" || s.label), pane.report());
  assert.ok(!pane.now.token, `token left: ${pane.now.token}`);
}, { integration: false }));

