import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./support/temp-root.js";

const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = fileURLToPath(new URL("./fixtures/provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));

for (const host of ["cli", "t3"]) test(`the ${host} RPC parent discovers only its own management commands and skills`, () => {
  const temp = tempRoot("native-host-");
  try {
    const output = execFileSync(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files",
      "--no-session", "-e", provider, "-e", extension, "--model", "subagent-test/stub"], {
      input: '{"type":"get_commands"}\n', cwd: temp, encoding: "utf8", timeout: 15_000,
      env: { HOME: temp, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(temp, "agent"),
        ...(host === "t3" ? { T3_MCP_URL: "http://127.0.0.1:1/mcp" } : {}) },
    });
    const reply = output.trim().split("\n").map(line => JSON.parse(line)).find(e => e.command === "get_commands");
    assert.equal(reply?.success, true);
    const names = reply.data.commands.map((c: { name: string }) => c.name);
    for (const name of ["subagents", "workflows", "loop", "skill:subagents", "skill:workflows"]) assert.equal(names.includes(name), host === "cli", name);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
