import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHost, registerHostAware } from "./host.ts";

const recorder = () => {
  const tools: Record<string, unknown>[] = [];
  return { tools, pi: { registerTool: (tool: Record<string, unknown>) => { tools.push(tool); } } };
};

test("a Pi launched by T3 Code is detected from T3_MCP_URL alone", () => {
  assert.equal(detectHost({ T3_MCP_URL: "http://127.0.0.1:3773/mcp" }), "t3");
  assert.equal(detectHost({}), "cli");
  assert.equal(detectHost({ T3_MCP_URL: "" }), "cli", "an empty variable is not a T3 launch");
});

test("under T3 a tool that duplicates a T3 primitive stays reachable through tool_search and codemode only", () => {
  const { tools, pi } = recorder();
  const host = registerHostAware(pi, { name: "loop", exposure: "direct" }, { duplicatesT3: true, env: { T3_MCP_URL: "http://t3" } });
  assert.equal(host, "t3");
  assert.deepEqual(tools, [{ name: "loop", exposure: "deferred" }]);
});

test("a tool keeps its own exposure when it does not duplicate T3 or Pi runs in a terminal", () => {
  const { tools, pi } = recorder();
  registerHostAware(pi, { name: "ask_user", exposure: "model-only" }, { duplicatesT3: false, env: { T3_MCP_URL: "http://t3" } });
  registerHostAware(pi, { name: "loop" }, { duplicatesT3: true, env: {} });
  assert.deepEqual(tools, [{ name: "ask_user", exposure: "model-only" }, { name: "loop" }]);
});

test("a hidden tool is never widened to deferred", () => {
  const { tools, pi } = recorder();
  registerHostAware(pi, { name: "withdrawn", exposure: "hidden" }, { duplicatesT3: true, env: { T3_MCP_URL: "http://t3" } });
  assert.deepEqual(tools, [{ name: "withdrawn", exposure: "hidden" }]);
});
