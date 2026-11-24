// Print the newest matching Pi session mtime (epoch seconds), or zero if none.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseArgs } from "node:util";

const { positionals: [main, wt], values } = parseArgs({
  allowPositionals: true, options: { "session-dir": { type: "string" } },
});
const encoded = path => `--${path.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
const below = (cwd, root) => cwd === root || cwd.startsWith(root + "/");
const needle = JSON.stringify(wt).slice(1, -1);

async function touched(file) {
  const handle = await open(file, "r");
  try {
    let header = true;
    for await (const line of handle.readLines()) {
      if (header) {
        // Encoded cwd names can collide; a custom directory can hold several projects.
        const entry = JSON.parse(line);
        if (entry.type !== "session" || typeof entry.cwd !== "string") throw Error(`Invalid session header: ${file}`);
        if (below(entry.cwd, wt)) return true;
        if (!below(entry.cwd, main)) return false;
        header = false;
      } else if (line.includes(needle + "/") || line.includes(needle + '"')) return true;
    }
    if (header) throw Error(`Empty session file: ${file}`);
    return false;
  } finally { await handle.close(); }
}

async function configuredDir(file) {
  try { return JSON.parse(await readFile(file, "utf8")).sessionDir; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const absolute = path => resolve(path.replace(/^~(?=\/|$)/, () => homedir()));
const agent = absolute(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"));
const selected = values["session-dir"] || process.env.PI_CODING_AGENT_SESSION_DIR
  || await configuredDir(".pi/settings.json") || await configuredDir(join(agent, "settings.json"));
const custom = selected && absolute(selected);
const defaultRoot = join(agent, "sessions");
const prefixes = [encoded(main), encoded(wt)].map(bin => bin.slice(0, -2) + "-");
const dirs = new Set();
for (const root of new Set([defaultRoot, custom].filter(Boolean))) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT" && root !== custom) continue; throw error; }
  if (root === custom) dirs.add(root); // Explicit session directories can be flat.
  for (const { name } of entries) {
    if (name.endsWith("--") && prefixes.some(prefix => name.startsWith(prefix))) {
      dirs.add(join(root, name));
    }
  }
}
let newest = 0;
for (const dir of dirs) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".jsonl") || entry.isDirectory()) continue;
    const file = join(dir, entry.name);
    if (!entry.isFile()) throw Error(`Not a regular session file: ${file}`);
    if (await touched(file)) newest = Math.max(newest, (await stat(file)).mtimeMs);
  }
}
console.log(Math.floor(newest / 1000));
