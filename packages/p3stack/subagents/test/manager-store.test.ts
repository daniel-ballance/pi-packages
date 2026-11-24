import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { tempRoot } from "./support/temp-root.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const spawn = (m: SubagentManager, task: string) => m.spawn({ name: "worker", task, cwd: m.directory, executable: process.execPath, executableArgs: [fixture] });

test("a crash before the registry rename leaves the archived report and its wake unacknowledged", async () => {
  const dir = tempRoot("manager-archive-"), registry = join(dir, "registry.json");
  let m = new SubagentManager(dir);
  try {
    const { id } = await spawn(m, "first"); await m.wait([id], "all", 2000); await m.close(id, true);
    const { id: other } = await spawn(m, "second"); await m.wait([other], "all", 2000); await m.close(other, true);
    assert.ok(JSON.parse(fs.readFileSync(registry, "utf8")).agents.includes(id), "first child is archived");
    const keys = m.pendingNotices().map(n => n.key);
    fs.mkdirSync(registry + ".tmp"); // The old registry remains the commit point.
    assert.throws(() => m.inbox.prepareRead(id).acknowledge(), /Unsafe subagent state path/);
    fs.rmdirSync(registry + ".tmp");
    await m.shutdown(); m = new SubagentManager(dir);
    assert.deepEqual(m.pendingNotices().map(n => n.key), keys);
    assert.equal(m.get(id).readCursor, 0);
    assert.equal(m.get(id).resultReview?.status, "unreviewed");
    const { nextCursor } = m.read(id);
    await m.intervene(id, "halt");
    m.read(other); // Store the updated first child out of line again.
    await m.shutdown(); m = new SubagentManager(dir);
    assert.equal(m.get(id).readCursor, nextCursor);
    assert.equal(m.get(id).resultReview?.status, "reviewed");
    assert.equal(m.get(id).hold?.outcome, "confirmed");
    assert.deepEqual(m.pendingNotices().map(n => n.kind), ["human_intervention", "human_intervention"]);
  } finally { await m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one child's turn does not rewrite archived children's history", async t => {
  const root = tempRoot("manager-io-");
  let sample: number[] | undefined;
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (typeof args[0] === "string" && args[0].startsWith(root) && /\.json(?:\.tmp)?$/.test(args[0]) && sample) {
      sample.push(Buffer.byteLength(args[1]));
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const seed = new SubagentManager(join(root, "seed"));
    let legacy: string, oldId: string;
    try {
      const { id } = await spawn(seed, "z".repeat(1000));
      await seed.wait([id], "all", 2000); seed.read(id); await seed.close(id);
      legacy = JSON.stringify(seed.get(id)); oldId = id;
    } finally { await seed.shutdown(); }
    const means: number[] = [];
    for (const saved of [1, 10, 50]) {
      const dir = join(root, String(saved)); fs.mkdirSync(dir);
      // Start from v1 rows with the actual retained updates, assignment, usage and saved answer.
      const agents = Array.from({ length: saved - 1 }, (_, i) => JSON.parse(legacy.replaceAll(oldId, `subagent-${i.toString(16).padStart(8, "0")}`)));
      fs.writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 1, agents }));
      const m = new SubagentManager(dir);
      try {
        const { id } = await spawn(m, "ready"); await m.wait([id], "all", 2000); m.read(id);
        sample = [];
        await m.refreshUsageSnapshots();
        assert.deepEqual(sample, [], "a usage-only refresh must not write durable state");
        await m.send(id, "measure"); await m.wait([id], "all", 2000); m.read(id);
        const bytes = sample.reduce((a, b) => a + b, 0), mean = Math.round(bytes / sample.length);
        t.diagnostic(`${saved} saved: ${sample.length} store writes/turn, ${mean} mean bytes/write (${bytes} bytes)`);
        assert.ok(sample.length > 0 && sample.length <= 6, `unexpected writes for a single report and receipt: ${sample.length}`);
        means.push(mean); sample = undefined;
      } finally { await m.shutdown(); }
    }
    assert.ok(means[2] < 3 * means[0], `write size grew with archived history: ${means}`);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true });
  }
});
