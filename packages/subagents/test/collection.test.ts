import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectReports } from "../extensions/subagents/src/collection.js";
import type { AgentRecord } from "../extensions/subagents/src/manager.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "collect-reports-"));
  const manager = new SubagentManager(directory);
  const records = new Map<string, AgentRecord>();
  // No child process is needed: exercise real read/ack logic on deterministic retained records.
  manager.get = (id: string) => { const record = records.get(id); if (!record) throw new Error(id); return record; };
  const add = (id: string, text: string) => {
    const record: AgentRecord = {
      id, name: id, task: "task", config: { cwd: directory }, status: "idle", createdAt: "now", updatedAt: "now",
      sessionFile: "session", logFile: "log", stderrFile: "stderr", uiRequests: [], hadEnvOverrides: false,
      cursor: 2, readCursor: 0, updates: [
        { cursor: 1, kind: "lifecycle", text: "ready", time: "now" },
        { cursor: 2, kind: "assistant", text, time: "now" },
      ],
    };
    records.set(id, record); return record;
  };
  return { manager, add, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("collection peeks without acknowledging and returns contiguous bounded pages", () => {
  const s = fixture();
  try {
    const a = s.add("a", "x".repeat(2000)); s.add("b", "b result");
    const data = collectReports(s.manager, ["a", "b"], 1500);
    assert.equal(a.readCursor, 0);
    assert.equal(data.reports[0].nextCursor, 1);
    assert.equal(data.reports[0].hasMore, true);
    assert.ok(data.deferred.includes("a"));
    assert.ok(Buffer.byteLength(JSON.stringify(data.reports, null, 2)) <= 1500);
    s.manager.acknowledgeRead(data.reports[0], true);
    assert.equal(a.readCursor, 1);
    const next = collectReports(s.manager, ["a"]);
    assert.equal(next.reports[0].updates[0].cursor, 2);
  } finally { s.close(); }
});

test("oversized first updates remain unread and are explicitly deferred", () => {
  const s = fixture();
  try {
    const a = s.add("a", "x".repeat(2000)); a.readCursor = 1;
    const data = collectReports(s.manager, ["a"], 600);
    assert.deepEqual(data.reports, []);
    assert.deepEqual(data.deferred, ["a"]);
    assert.equal(a.readCursor, 1);
  } finally { s.close(); }
});
