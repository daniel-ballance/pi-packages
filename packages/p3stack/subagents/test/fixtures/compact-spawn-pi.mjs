#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : "";
const policy = process.env.PI_SUBAGENT_POLICY ? JSON.parse(process.env.PI_SUBAGENT_POLICY) : undefined;
const modelId = policy?.model ?? "p/m:off";
const colon = modelId.lastIndexOf(":");
const spec = modelId.slice(0, colon);
const slash = spec.indexOf("/");
const state = {
  sessionFile,
  sessionId: "compact-spawn",
  model: { provider: spec.slice(0, slash), id: spec.slice(slash + 1) },
  thinkingLevel: modelId.slice(colon + 1),
  isStreaming: false,
};

function emit(packet) {
  process.stdout.write(`${JSON.stringify(packet)}\n`);
}

function respond(cmd, data) {
  emit({ type: "response", id: cmd.id, success: true, data });
}

function fail(cmd, error) {
  process.stderr.write(`${error}\n`);
  emit({ type: "response", id: cmd.id, success: false, error: String(error) });
}

function manage(body) {
  const pipe = new Socket({ fd: 3, readable: true, writable: true });
  pipe.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("manage timed out")), 20000);
    pipe.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      const packet = JSON.parse(text.slice(0, end));
      if (packet.success === true) resolve(packet.data);
      else reject(new Error(packet.error || "manage failed"));
    });
    pipe.on("error", error => { clearTimeout(timer); reject(error); });
    pipe.write(`${JSON.stringify({ id: 1, ...body })}\n`);
  });
}

async function handle(cmd) {
  try {
    if (cmd.type === "get_state") return respond(cmd, state);
    if (cmd.type === "get_session_stats") return respond(cmd, {});
    if (cmd.type === "prompt" && cmd.message === "/_child-policy-check") {
      emit({ type: "entry_appended", entry: { customType: "child-policy-check", data: { tools: Object.keys(policy?.toolSources ?? {}) } } });
      return respond(cmd, { disposition: "handled" });
    }
    if (cmd.type === "prompt") {
      const allowed = JSON.parse(process.env.PI_SUBAGENT_ALLOWED_TOOLS ?? "[]");
      const prompted = process.env.SPAWN_ON;
      if (allowed.includes("subagent_spawn") && (prompted ? cmd.message === prompted : !!process.env.SPAWN_PROOF)) {
        const task = prompted ? cmd.message : readFileSync(process.env.SPAWN_TASK_FILE, "utf8");
        const data = await manage({ op: "spawn", args: { name: "worker", task, cwd: process.cwd(), model: "p/m:off", tools: [] } });
        if (process.env.SPAWN_PROOF) writeFileSync(process.env.SPAWN_PROOF, JSON.stringify(data));
      }
      return respond(cmd, { disposition: "started" });
    }
    fail(cmd, `unhandled ${cmd.type}`);
  } catch (error) {
    fail(cmd, error);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
