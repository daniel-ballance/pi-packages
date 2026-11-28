import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mapUpdate, mergeCall, piTool, type ObservedCall } from "../extensions/antigravity-provider/src/observed.js";
import { appendPrompt, forwardedSections, instructionsUpdate } from "../extensions/antigravity-provider/src/prompt.js";
import { mapUsage } from "../extensions/antigravity-provider/src/response.js";
import { listTools } from "../extensions/antigravity-provider/src/tools.js";

const system = JSON.parse(readFileSync(new URL("fixtures/pi-system.json", import.meta.url), "utf8")) as SystemMessage;
const location = { cwd: "/workspace/repo/pkg", root: "/workspace/repo" };

test("forwards ordered Pi context, not its harness or duplicate instructions agy loads", () => {
  const selected = forwardedSections(system, location);
  assert.deepEqual(selected.map(([name]) => name), ["addendum", "project_context", "skills", "p3stack", "t3_agent"]);
  assert.deepEqual(selected.filter(([name]) => name !== "project_context"), ["addendum", "skills", "p3stack", "t3_agent"].map(name => [name, system.sections?.[name]]));
  const rendered = appendPrompt("model-id", selected);
  assert.match(rendered, /running in Pi through the Antigravity CLI over ACP, as model-id/);
  assert.match(rendered, /call call_pi_tool .* schema, then again with args as a JSON object string/);
  assert.match(rendered, /outside root instructions.*global instructions/s);
  assert.doesNotMatch(rendered, /inside pi|repository instructions|leaf instructions|Pi documentation|<tools>|<rules>|<cwd>/i);
});

test("an opaque forced prompt contributes no sections; section changes and removals are explicit", () => {
  assert.deepEqual(forwardedSections({ role: "system", timestamp: 0, content: "forced private text" }, location), []);
  const patch: SystemMessage = { role: "system", timestamp: 1, content: "", sections: { p3stack: null, t3_agent: "updated" } };
  const current = getCurrentSystemMessage([system, patch]);
  const update = instructionsUpdate(forwardedSections(system, location), forwardedSections(current, location));
  assert.match(update ?? "", /Pi updated these instructions.*removed the p3stack section.*updated/s);
  assert.doesNotMatch(update ?? "", /project_instructions|<skills>/);
});

test("MCP excludes agy's native equivalents and orchestration surfaces, not callable deferred tools", () => {
  const names = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "codemode", "tool_search", "antigravity", "await_tool_result"];
  const create = (name: string) => ({ name, description: name, parameters: Type.Object({ value: Type.String() }) });
  const fixtures = [...names.map(create), { ...create("direct"), exposure: "direct" as const }, create("inactive"),
    { ...create("deferred"), exposure: "deferred" as const }, { ...create("nested"), exposure: "codemode" as const },
    { ...create("model"), exposure: "model-only" as const }, { ...create("hidden"), exposure: "hidden" as const }];
  const tools = listTools(fixtures, new Set([...names, "direct", "model", "hidden"]), true);
  assert.deepEqual(tools.map(tool => tool.name), ["direct", "deferred", "nested", "call_pi_tool", "await_tool_result"]);
  assert.deepEqual(listTools(fixtures, new Set(names), false).map(tool => tool.name), ["await_tool_result"]);
  assert.deepEqual(tools[0].inputSchema, { type: "object", required: ["value"], properties: { value: { type: "string" } } });
});

test("usage leaves cache reads separate and does not count thinking twice", () => {
  const sample = { inputTokens: 12, outputTokens: 17, cachedReadTokens: 7, cachedWriteTokens: 4, thoughtTokens: 3 };
  assert.deepEqual(mapUsage(sample), { input: 12, output: 17, cacheRead: 7, cacheWrite: 4, reasoning: 3, totalTokens: 40 });
  assert.equal(mapUsage({ ...sample, totalTokens: 36 }).totalTokens, 36);
});

test("maps ACP chunks, context size, and tool frames and recognizes both Pi MCP forms", () => {
  assert.deepEqual(mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } }), { kind: "thinking", text: "thought" });
  assert.deepEqual(mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "text" } }), { kind: "text", text: "text" });
  assert.deepEqual(mapUpdate({ sessionUpdate: "usage_update", used: 17, size: 100 }), { kind: "window", size: 100 });
  const frame = { toolCallId: "1", title: "run_command", kind: "execute", status: "pending", rawInput: { CommandLine: "npm test", Cwd: "/workspace" } } as const;
  assert.equal(mapUpdate({ ...frame, sessionUpdate: "tool_call" })?.kind, "start");
  assert.equal(mapUpdate({ toolCallId: "1", status: "completed", sessionUpdate: "tool_call_update" })?.kind, "change");
  const call: ObservedCall = { id: "1", title: "", kind: "other", status: "pending", diff: [] };
  mergeCall(call, frame);
  mergeCall(call, { toolCallId: "1", status: "completed", rawOutput: { combinedOutput: "ok" } });
  assert.deepEqual([call.title, call.output, call.status], ["Run command: npm test", "ok", "completed"]);
  assert.equal(piTool({ toolCallId: "2", title: "Run mcp_pi_fixture?" }), "fixture");
  assert.equal(piTool({ toolCallId: "3", title: "MCP Tool other", rawInput: { ServerName: "pi", ToolName: "other" } }), "other");
  assert.equal(piTool({ toolCallId: "4", title: "MCP Tool other", rawInput: { ServerName: "foreign", ToolName: "other" } }), undefined);
});
