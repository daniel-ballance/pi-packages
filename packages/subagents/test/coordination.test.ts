import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeCoordination, coordinationWarnings, recoverySummary } from "../extensions/subagents/src/coordination.js";
import { tempRoot } from "./support/temp-root.js";

test("coordination normalizes paths, warns about ancestors/outputs and excludes stopped workers", () => {
  const cwd = tempRoot("coordination-");
  try {
    const declaration = normalizeCoordination({ owns: ["src", "./src"], outputs: ["reports/result.md"] }, cwd);
    assert.deepEqual(declaration?.owns, [join(cwd, "src")]);
    const workers = [
      { id: "a", name: "worker a", cwd, pid: 1, status: "idle", coordination: { owns: ["src/auth.ts"] } },
      { id: "b", name: "worker b", cwd, pid: 2, status: "working", coordination: { outputs: ["reports"] } },
      { id: "c", name: "worker c", cwd, status: "stopped", coordination: { owns: ["src"] } },
      { id: "d", name: "worker d", cwd, pid: 4, status: "working", coordination: { owns: ["src-extra"] } },
    ];
    assert.deepEqual(coordinationWarnings(declaration, workers).map(w => w.id), ["a", "b"]);
    assert.deepEqual(coordinationWarnings(declaration, workers, "a").map(w => w.id), ["b"]);
    assert.throws(() => normalizeCoordination({ owns: ["\0"] }, cwd), /nonempty paths/);
    assert.throws(() => normalizeCoordination({ owns: Array(33).fill("src") }, cwd), /32/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("missing outputs behind symlink aliases resolve to the same declaration", { skip: process.platform === "win32" }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "coordination-alias-"));
  try {
    mkdirSync(join(cwd, "real")); symlinkSync(join(cwd, "real"), join(cwd, "alias"));
    assert.deepEqual(normalizeCoordination({ owns: ["alias/new/file.ts"] }, cwd), normalizeCoordination({ owns: ["real/new/file.ts"] }, cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("recovery respects human holds, reservations and process identity", () => {
  const workers = [
    { id: "idle", name: "idle", cwd: "/tmp", status: "idle", pid: 1 },
    { id: "held-live", name: "held", cwd: "/tmp", status: "idle", pid: 2, hold: { kind: "halt" } },
    { id: "held-stopped", name: "held", cwd: "/tmp", status: "stopped", hold: { kind: "kill" } },
    { id: "stopped", name: "stopped", cwd: "/tmp", status: "stopped" },
  ];
  const recovery = recoverySummary(workers, { limit: 4, live: 2, reserved: 2, available: 0 });
  assert.equal(recovery.capacity.available, 0);
  assert.deepEqual(recovery.heldIds, ["held-live", "held-stopped"]);
  assert.deepEqual(recovery.candidates.send, ["idle"]);
  assert.deepEqual(recovery.candidates.resume, ["stopped"]);
  assert.match(recovery.guidance, /discussion/);
});
