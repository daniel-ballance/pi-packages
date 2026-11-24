#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAt, gitEnv, requireCleanCheckout } from "./git-env.mjs";
import { borrowedNote, sourcePathClassifier, sourcesOf } from "./source-paths.mjs";

const generator = join(dirname(fileURLToPath(import.meta.url)), "generate.mjs");

function main(args) {
  if (args.length < 1 || args.length > 2 || args.some(arg => arg.startsWith("-"))) {
    console.error("Usage: node generator/update-upstream.mjs <source> [ref]");
    return 2;
  }
  const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(generator), ".."));
  const manifest = JSON.parse(readFileSync(join(packageDir, "rules/manifest.json"), "utf8"));
  const sources = sourcesOf(manifest), source = sources.find(({ name }) => name === args[0]);
  if (!source) { console.error(`Unknown source "${args[0]}". Available sources: ${sources.map(({ name }) => name).join(", ")}`); return 1; }
  const { upstream } = source;
  if (!upstream) { console.error(`${source.name}: rules/manifest.json names no upstream checkout`); return 1; }
  const checkoutOf = source => resolve(packageDir, source.upstream.checkout);
  const subtreeOf = source => relative(checkoutOf(source), join(packageDir, source.vendor)).split("\\").join("/") || ".";
  const checkout = checkoutOf(source);
  const members = sources.filter(member => member.upstream && checkoutOf(member) === checkout);
  if (!existsSync(join(checkout, ".git"))) { console.error(`${upstream.checkout} is not checked out; run npm run sync first`); return 1; }
  const git = (...args) => gitAt(checkout, ...args);
  // Checkout moves the entire tree; regeneration also consumes the other pinned sources.
  requireCleanCheckout(checkout);
  for (const other of sources) if (other.upstream && !members.includes(other)) requireCleanCheckout(checkoutOf(other), subtreeOf(other));
  const branch = upstream.branch ?? "main", ref = args[1] ?? `origin/${branch}`;
  git("fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`, "--tags");
  const from = git("rev-parse", "HEAD");
  let to;
  try { to = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); }
  catch { console.error(`${ref}: not a commit in ${upstream.repository}`); return 1; }

  console.log(`Source "${source.name}" (${upstream.repository})`);
  if (from === to) console.log(`${upstream.repository} is already at ${to.slice(0, 7)}.`);
  else {
    const forward = spawnSync("git", ["-C", checkout, "merge-base", "--is-ancestor", from, to], { env: gitEnv() }).status === 0;
    git("checkout", "--quiet", "--detach", to);
    console.log(`${upstream.repository}: ${from.slice(0, 7)} -> ${to.slice(0, 7)}${forward ? "" : " (not a descendant of the old pin)"}`);
    const subtrees = [...new Set(members.map(subtreeOf))], scope = subtrees.map(path => path + "/").join(", ");
    const log = git("log", "--oneline", "--no-decorate", forward ? `${from}..${to}` : to, ...(forward ? [] : ["-n", "20"]), "--", ...subtrees);
    console.log(log ? `Upstream commits touching ${scope}:\n${log.replace(/^/gm, "  ")}` : `No upstream commits touch ${scope}.`);
    const changes = git("diff", "--name-status", "--no-renames", "-z", from, to, "--", ...subtrees).split("\0").slice(0, -1);
    const skills = manifest.registry ? JSON.parse(readFileSync(join(packageDir, "registry/skills.json"), "utf8")) : undefined;
    const borrowedPath = join(packageDir, "rules/borrowed.json");
    const borrowed = existsSync(borrowedPath) ? JSON.parse(readFileSync(borrowedPath, "utf8")) : [];
    for (const member of members) {
      const subtree = subtreeOf(member), prefix = subtree === "." ? "" : subtree + "/";
      const classify = sourcePathClassifier(member, skills);
      console.log(`Changed upstream source paths for ${member.name} (manifest scope):`);
      for (let index = 0; index < changes.length; index += 2) {
        const [status, path] = changes.slice(index, index + 2);
        if (!path.startsWith(prefix)) continue;
        const local = path.slice(prefix.length);
        const { kind, output } = classify(local);
        const scope = output === undefined ? ` (${kind}${["not emitted", "unclassified"].includes(kind) ? "; review scope" : ""})` : ` -> ${output}`;
        console.log(`  ${status} ${path}${scope}${borrowedNote(borrowed, member.name, local)}`);
      }
    }
    console.log(`Review the full upstream commits too: packaging and generated harness trees may live outside ${scope}.`);
  }

  const generated = spawnSync(process.execPath, [generator], { stdio: "inherit", env: process.env });
  if (generated.error) throw new Error(`Cannot start generation: ${generated.error.message}`);
  if (generated.status !== 0) {
    console.error(`\nGeneration failed at ${to.slice(0, 7)}. Resolve the diagnostic above, then rerun node generator/generate.mjs. See AGENTS.md, "Updating upstream".`);
    return 1;
  }
  console.log("\nRegenerated. Review the semantic delta with git diff -- skills agents, then run npm run check and npm test,");
  console.log(`and commit ${upstream.checkout} together with the regenerated output.`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
