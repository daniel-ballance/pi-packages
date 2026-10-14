// Live checks of claude-subscription against the real Pi binary, the real Claude Code and a
// real Claude plan. Run by hand before a release: see README.md. Nothing here is part of `npm test`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  RpcPi,
  Workspace,
  answerOf,
  assistantMessages,
  runPi,
  runPiRaw,
  textOf,
  toolCallsOf,
  unavailable,
  type Loose,
} from "./support.js";

const skip = unavailable();
const TEST_TIMEOUT_MS = 240_000;

/** A fresh workspace that is removed when the test ends. */
function workspace(t: TestContext, files: Record<string, string> = {}): Workspace {
  const ws = new Workspace(files);
  t.after(() => ws.remove());
  return ws;
}

/** A Pi in RPC mode that is closed when the test ends. */
function rpc(t: TestContext, ws: Workspace, ...args: string[]): RpcPi {
  const pi = new RpcPi(ws, ws.piArgs("--no-session", ...args));
  t.after(() => pi.close());
  return pi;
}

function succeeded(run: { code: number | null; stderr: string }): void {
  assert.equal(run.code, 0, `pi exited with ${run.code}\nstderr: ${run.stderr.slice(-2000)}`);
}

describe("claude-subscription against the real Claude Code", { skip: skip ? `live suite skipped: ${skip}` : false }, () => {
  it("answers a plain prompt with text, a normal stop, token usage and no cost", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const run = await runPi(ws, ws.piArgs("--no-session"), "Reply with the single word kumquat.");
    succeeded(run);

    const [message] = assistantMessages(run.events);
    assert.equal(assistantMessages(run.events).length, 1);
    assert.match(textOf(message).toLowerCase(), /kumquat/);
    assert.equal(message.stopReason, "stop");
    assert.equal(message.provider, "claude-subscription");
    assert.ok(message.usage.totalTokens > 0, "token usage is reported");
    assert.ok(message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0);
    assert.equal(message.usage.cost.total, 0, "nothing is billed per token to Pi");
  });

  it("runs Pi's own read tool and serves both requests of the turn from one Claude Code process", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t, { "vault.txt": "The vault codeword is ZANZIBAR-4417.\n" });
    const run = await runPi(ws, ws.piArgs("--no-session", "--tools", "read"), "Use the read tool on vault.txt, then tell me its codeword.");
    succeeded(run);

    const started = run.events.filter(e => e.type === "tool_execution_start");
    assert.deepEqual(started.map(e => e.toolName), ["read"], "Pi ran its own read tool, not an mcp__pi__ name");
    const finished = run.events.filter(e => e.type === "tool_execution_end");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].isError, false);
    assert.match(JSON.stringify(finished[0].result), /ZANZIBAR-4417/);

    const messages = assistantMessages(run.events);
    assert.equal(messages.length, 2, "one request for the tool call, one for the answer");
    assert.equal(messages[0].stopReason, "toolUse");
    assert.deepEqual(toolCallsOf(messages[0]).map(call => call.name), ["read"]);
    assert.equal(messages[1].stopReason, "stop");
    assert.match(answerOf(run.events), /ZANZIBAR-4417/);
    assert.equal(ws.claudeSessionIds().length, 1, "both requests went to one Claude Code process");
  });

  it("runs two tools called in one assistant message and uses both results", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t, {
      "north.txt": "The north gate codeword is PELICAN-5521.\n",
      "south.txt": "The south gate codeword is WALRUS-7708.\n",
    });
    const run = await runPi(
      ws,
      ws.piArgs("--no-session", "--tools", "read"),
      "Read north.txt and south.txt with two read tool calls made together in the same message. Then give me both codewords.",
    );
    succeeded(run);

    const messages = assistantMessages(run.events);
    const together = messages.find(message => toolCallsOf(message).length >= 2);
    assert.ok(together, `no assistant message made two tool calls; calls per message: ${messages.map(m => toolCallsOf(m).length).join(", ")}`);
    const finished = run.events.filter(e => e.type === "tool_execution_end");
    assert.equal(finished.length, 2);
    assert.ok(finished.every(e => e.toolName === "read" && !e.isError));
    const results = JSON.stringify(finished.map(e => e.result));
    assert.match(results, /PELICAN-5521/);
    assert.match(results, /WALRUS-7708/);
    const answer = answerOf(run.events);
    assert.match(answer, /PELICAN-5521/);
    assert.match(answer, /WALRUS-7708/);
    assert.equal(ws.claudeSessionIds().length, 1);
  });

  it("continues the same Claude Code process for a second prompt, which remembers the first", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const pi = rpc(t, ws);

    const first = await pi.prompt("Remember this word: MARMALADE-93. Reply only with: noted.");
    assert.equal(assistantMessages(first).at(-1)?.stopReason, "stop");
    const second = await pi.prompt("Which word did I ask you to remember? Reply with that word only.");
    assert.equal(assistantMessages(second).at(-1)?.stopReason, "stop");
    assert.match(answerOf(second), /MARMALADE-93/);
    assert.equal(ws.claudeSessionIds().length, 1, "the second prompt did not start a new Claude Code process");
  });

  it("ends an aborted turn as aborted and still answers the next prompt", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const pi = rpc(t, ws);

    const from = pi.events.length;
    const accepted = await pi.command({ type: "prompt", message: "Write the numbers from 1 to 800, one per line, with no other text." });
    assert.equal(accepted.success, true);
    await pi.until(e => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta", from, "the first streamed text");
    const aborted = await pi.command({ type: "abort" });
    assert.equal(aborted.success, true);
    const settled = await pi.until(e => e.type === "agent_settled", from, "agent_settled after the abort");
    assert.equal(settled.aborted, true);
    assert.equal(assistantMessages(pi.events.slice(from)).at(-1)?.stopReason, "aborted");

    const next = await pi.prompt("Reply with the single word kumquat.");
    const last = assistantMessages(next).at(-1);
    assert.equal(last?.stopReason, "stop");
    assert.match(textOf(last).toLowerCase(), /kumquat/);
  });

  it("recalls a fact after a saved session is continued by a new Pi process", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const args = ws.piArgs("--session-dir", ws.sessionDir);

    succeeded(await runPi(ws, args, "Remember this word: QUINCE-6150. Reply only with: noted."));
    const files = readdirSync(ws.sessionDir).filter(name => name.endsWith(".jsonl"));
    assert.equal(files.length, 1, "Pi saved one session file");
    assert.match(readFileSync(join(ws.sessionDir, files[0]), "utf8"), /QUINCE-6150/);
    const before = ws.claudeSessionIds();

    const second = await runPi(ws, [...args, "-c"], "Which word did I ask you to remember? Reply with that word only.");
    succeeded(second);
    assert.match(answerOf(second.events), /QUINCE-6150/);
    assert.equal(readdirSync(ws.sessionDir).filter(name => name.endsWith(".jsonl")).length, 1, "the same session file was continued");
    t.diagnostic(`Claude Code session ids: first run ${before.join(",")}, whole log ${ws.claudeSessionIds().join(",")}`);
  });

  it("succeeds with thinking set to high, and notes whether a thinking block came back", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const run = await runPi(ws, ws.piArgs("--no-session", "--thinking", "high"), "What is 17 * 23 + 19? Think it through, then reply with the number only.");
    succeeded(run);

    const message = assistantMessages(run.events).at(-1);
    assert.equal(message.stopReason, "stop");
    assert.match(textOf(message), /410/);
    const thinking = message.content.filter((block: Loose) => block.type === "thinking");
    // The model decides whether to think, so this is recorded, not asserted.
    t.diagnostic(`thinking block returned: ${thinking.length > 0 ? `yes (${thinking.length}, ${thinking.map((b: Loose) => String(b.thinking ?? "").length).join("+")} chars)` : "no"}`);
  });

  it("reports plan-limit utilization per window during a turn", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const run = await runPi(ws, ws.piArgs("--no-session"), "Reply with the single word kumquat.");
    succeeded(run);

    const events = ws.sdkMessages().filter(m => m.type === "rate_limit_event");
    assert.ok(events.length > 0, "no rate_limit_event arrived during the turn");
    const windows = Object.entries<Loose>(events.at(-1).rate_limit_info.unifiedWindows ?? {});
    assert.ok(windows.length > 0, `the event carries no per-window figures: ${JSON.stringify(events.at(-1).rate_limit_info)}`);
    for (const [name, window] of windows) {
      assert.equal(typeof window.utilization, "number", `${name} has a utilization`);
      assert.ok(window.utilization >= 0, `${name} utilization is not negative`);
    }
    t.diagnostic(`windows: ${windows.map(([name, w]) => `${name}=${Math.round(w.utilization * 100)}%`).join(", ")}`);
  });

  it("lists models that each have a context window and an output limit", { timeout: 60_000 }, async t => {
    const ws = workspace(t);
    const run = await runPiRaw(ws, ws.extensionArgs("--list-models", "claude-subscription"));
    succeeded(run);

    const [header, ...rows] = run.stdout.split("\n").filter(line => line.trim());
    const columns = header.trim().split(/\s+/);
    const context = columns.indexOf("context");
    const maxOut = columns.indexOf("max-out");
    assert.ok(context >= 0 && maxOut >= 0, `the table has no context and max-out columns: ${header}`);
    assert.ok(rows.length > 0, "no claude-subscription models are listed");
    for (const row of rows) {
      const cells = row.trim().split(/\s+/);
      assert.equal(cells[0], "claude-subscription", `unexpected provider in: ${row}`);
      assert.match(cells[context], /^\d+(\.\d+)?[KM]?$/, `no context window in: ${row}`);
      assert.match(cells[maxOut], /^\d+(\.\d+)?[KM]?$/, `no output limit in: ${row}`);
      assert.notEqual(parseFloat(cells[context]), 0, `empty context window in: ${row}`);
      assert.notEqual(parseFloat(cells[maxOut]), 0, `empty output limit in: ${row}`);
    }
    assert.match(run.stdout, /claude-haiku-5-5/, "the model the suite relies on is listed");
    t.diagnostic(`${rows.length} models listed`);
  });

  it("fails on an unknown model id with a readable error instead of hanging", { timeout: TEST_TIMEOUT_MS }, async t => {
    const ws = workspace(t);
    const started = Date.now();
    const run = await runPiRaw(ws, ws.extensionArgs("--no-session", "--model", "claude-subscription/claude-no-such-model-9", "-p", "Reply with the word kumquat."));

    const output = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.code, 0, "an unknown model must not look like success");
    assert.match(output, /claude-no-such-model-9/, "the error names the model");
    assert.match(output, /may not exist|not found|no access|not available/i, "the error says what is wrong");
    assert.doesNotMatch(output, /kumquat/i);
    t.diagnostic(`failed after ${Date.now() - started} ms: ${output.trim().split("\n").at(-1)}`);
  });
});
