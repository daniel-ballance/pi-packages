import type { Host } from "../extensions/subagents/src/host.js";

// Host-sensitive fixtures select a launch explicitly, independent of the test runner.
export function asHost<T>(host: Host, run: () => T): T {
  const previous = process.env.T3_MCP_URL;
  if (host === "t3") process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  else delete process.env.T3_MCP_URL;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.T3_MCP_URL;
    else process.env.T3_MCP_URL = previous;
  }
}

// Environment for a Pi process that must behave as a terminal launch.
export function cliEnv(): NodeJS.ProcessEnv {
  const { T3_MCP_URL: _url, T3_MCP_BEARER_TOKEN: _token, ...env } = process.env;
  return env;
}
