#!/usr/bin/env node
// Move the vendored upstream to a new commit and regenerate.
//
//   node generator/update-upstream.mjs          the tip of the upstream branch
//   node generator/update-upstream.mjs <ref>    a commit, tag or remote branch
//
// Fetches the upstream checkout, moves it to <ref>, lists upstream's commits to
// the emitted subtree, then regenerates. When a rule no longer fits, generation
// fails naming it and the checkout stays at <ref>: fix the rule and run
// node generator/generate.mjs until it passes. Commit the checkout's new
// gitlink together with the regenerated output.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generator = join(dirname(fileURLToPath(import.meta.url)), "generate.mjs");

function main(args) {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    console.error("Usage: node generator/update-upstream.mjs [ref]");
    return 2;
  }
  const packageDir = resolve(process.env.PISTACK_PACKAGE_DIR ?? join(dirname(generator), ".."));
  const { vendor, upstream } = JSON.parse(readFileSync(join(packageDir, "rules/manifest.json"), "utf8"));
  if (!upstream) { console.error("rules/manifest.json names no upstream checkout"); return 1; }
  const checkout = join(packageDir, upstream.checkout), subtree = relative(checkout, join(packageDir, vendor)) || ".";
  if (!existsSync(join(checkout, ".git"))) { console.error(`${upstream.checkout} is not checked out; run npm run sync first`); return 1; }
  const git = (...gitArgs) => execFileSync("git", ["-C", checkout, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  if (git("status", "--porcelain")) { console.error(`${upstream.checkout} has local changes; the generator reads upstream only, so discard them first`); return 1; }
  const branch = upstream.branch ?? "main", ref = args[0] ?? `origin/${branch}`;
  git("fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`, "--tags");
  const from = git("rev-parse", "HEAD");
  let to;
  try { to = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); }
  catch { console.error(`${ref}: not a commit in ${upstream.repository}`); return 1; }

  if (from === to) console.log(`${upstream.repository} is already at ${to.slice(0, 7)}.`);
  else {
    const forward = spawnSync("git", ["-C", checkout, "merge-base", "--is-ancestor", from, to]).status === 0;
    git("checkout", "--quiet", "--detach", to);
    console.log(`${upstream.repository}: ${from.slice(0, 7)} -> ${to.slice(0, 7)}${forward ? "" : " (not a descendant of the old pin)"}`);
    const log = git("log", "--oneline", "--no-decorate", forward ? `${from}..${to}` : to, ...(forward ? [] : ["-n", "20"]), "--", subtree);
    console.log(log ? `Upstream commits touching ${subtree}/:\n${log.replace(/^/gm, "  ")}` : `No upstream commits touch ${subtree}/.`);
  }

  const generated = spawnSync(process.execPath, [generator], { stdio: "inherit", env: process.env });
  if (generated.status !== 0) {
    console.error(`\nGeneration failed at ${to.slice(0, 7)}. Each line above names a rule, section or patch upstream no longer fits.`);
    console.error("Fix it, then run node generator/generate.mjs until it passes. See AGENTS.md, \"Updating upstream\".");
    return 1;
  }
  console.log("\nRegenerated. Review the semantic delta with git diff -- skills agents, then run npm run check and npm test,");
  console.log(`and commit ${upstream.checkout} together with the regenerated output.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
