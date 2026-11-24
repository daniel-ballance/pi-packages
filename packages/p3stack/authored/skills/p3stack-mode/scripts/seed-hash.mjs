#!/usr/bin/env node
// Fingerprint the parent's seed before dispatch; compare only after submission.
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

async function seedHash(root, artifact) {
  const tree = createHash("sha256");
  async function visit(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isDirectory()) {
      if (relative) tree.update(JSON.stringify([relative, "dir", stat.mode & 0o777]) + "\n");
      for (const name of readdirSync(path).sort()) {
        if (!relative && name === "response.md") {
          if (artifact) continue;
          throw new Error("response.md is reserved by the workflow engine");
        }
        await visit(join(relative, name));
      }
    } else if (stat.isFile() && relative) {
      const file = createHash("sha256");
      for await (const bytes of createReadStream(path)) file.update(bytes);
      tree.update(JSON.stringify([relative, "file", stat.mode & 0o777, file.digest("hex")]) + "\n");
    } else throw new Error(`Expected a regular seed file or directory: ${path}`);
  }
  await visit("");
  return tree.digest("hex");
}

try {
  const [arg, expected, ...extra] = process.argv.slice(2);
  if (arg === "--verify" && /^[a-f0-9]{64}$/.test(expected) && !extra.length) {
    const actual = await seedHash(process.env.WORKFLOW_CANDIDATE, true);
    if (actual !== expected) {
      console.error(`Seed changed: expected ${expected}, got ${actual}`);
      process.exitCode = 1;
    }
  } else if (arg && arg !== "--verify" && !expected) console.log(await seedHash(arg, false));
  else throw new Error("Usage: seed-hash.mjs <seed-dir> | --verify <parent-sha256>");
} catch (error) {
  console.error(`seed-hash: ${error.message}`);
  process.exitCode = 2;
}
