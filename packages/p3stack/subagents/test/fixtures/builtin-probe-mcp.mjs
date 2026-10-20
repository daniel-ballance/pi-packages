// Minimal local stdio fixture, not a production MCP client or server.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.argv[2], "started\n");
createInterface({ input: process.stdin }).on("line", line => {
  const packet = JSON.parse(line);
  if (packet.id === undefined) return;
  let result = {};
  if (packet.method === "initialize") result = {
    protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "builtin-probe", version: "1" },
  };
  else if (packet.method === "tools/list") result = { tools: ["read-file", "read_file"].map(name => ({
    name, description: "Read", inputSchema: { type: "object", properties: {} },
  })) };
  else if (packet.method === "tools/call") {
    appendFileSync(process.argv[2], `called ${packet.params.name}\n`);
    result = { content: [{ type: "text", text: "ok" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result }) + "\n");
});
