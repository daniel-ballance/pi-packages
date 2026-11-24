#!/usr/bin/env node
// Read-only receipt for a brownfield assessment; covers Git-visible state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readlinkSync } from "node:fs";

const git = (...args) => execFileSync("git", ["--no-optional-locks", ...args], { maxBuffer: 64 * 1024 * 1024 });
const sha = () => createHash("sha256");

try {
  process.chdir(git("rev-parse", "--show-toplevel").toString().trimEnd());
  const diff = (...args) => sha().update(git("diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", ...args, "--")).digest("hex");
  const manifest = sha(), names = git("ls-files", "--others", "--exclude-standard", "-z");
  for (const path of new TextDecoder("utf-8", { fatal: true }).decode(names).split("\0").filter(Boolean).sort()) {
    const stat = lstatSync(path), hash = sha();
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path, { encoding: "buffer" }));
    else if (stat.isFile()) for await (const chunk of createReadStream(path)) hash.update(chunk);
    else throw new Error(`Cannot fingerprint non-file: ${path}`);
    manifest.update(JSON.stringify([path, stat.mode, hash.digest("hex")]) + "\n");
  }
  console.log(JSON.stringify({ head: git("rev-parse", "HEAD").toString().trim(), staged: diff("--cached"), unstaged: diff(), untracked: manifest.digest("hex") }));
} catch (error) {
  console.error(`checkout-fingerprint: ${error.message}`);
  process.exitCode = 2;
}
