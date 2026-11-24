import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function walk(dir) {
  if (!existsSync(dir) && !isLink(dir)) return [];
  if (!lstatSync(dir).isDirectory()) return [""];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path).map(file => join(entry.name, file)));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(entry.name);
  }
  return files;
}

export function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export const referencePath = ({ owner, name }, file = "SKILL.md") =>
  `${owner}/references/${name}${file === "SKILL.md" ? ".md" : "/" + file}`;

// Plan all moves before writing any: an owner's own resources keep their paths.
export function referenceMoves(paths, skills) {
  const refs = new Map(skills.filter(row => row.action === "reference").map(row => [row.name, row]));
  const occupied = new Set(paths), moves = new Map();
  for (const path of paths) {
    const [, name, file] = /^skills\/([^/]+)\/(.+)$/.exec(path) ?? [];
    if (!refs.has(name)) continue;
    const dest = "skills/" + referencePath(refs.get(name), file);
    if (occupied.has(dest)) throw new Error(`${path} and another file both land at ${dest}`);
    if (dest.endsWith("/SKILL.md")) throw new Error(`${dest}: nested SKILL.md would register a reference as a skill`);
    moves.set(path, dest);
    occupied.add(dest);
  }
  return moves;
}

export function sourcesOf(manifest) {
  const names = new Set();
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) throw new Error("manifest.sources must be a nonempty array");
  for (const source of manifest.sources) {
    if (typeof source.name !== "string" || source.name.trim() === "") throw new Error("Each source needs a nonempty name");
    if (names.has(source.name)) throw new Error(`Duplicate source name "${source.name}"`);
    names.add(source.name);
  }
  return manifest.sources;
}

export function sourcePathClassifier(source, skills) {
  const exclude = (source.exclude ?? []).map((pattern, index) => {
    try { return new RegExp(pattern); }
    catch (error) { throw new Error(`rules/manifest.json: ${source.name} exclude[${index}]: ${error.message}`, { cause: error }); }
  });
  const rows = (skills ?? []).filter(row => row.source === source.name).map(row => ({ ...row, directory: row.path.slice(0, -"SKILL.md".length) }));
  return path => {
    const row = rows.find(row => path.startsWith(row.directory));
    if (row?.action === "drop") return { kind: "dropped" };
    if (skills && !row && (source.skillRoots ?? ["skills/"]).some(root => path.startsWith(root))) return { kind: path.endsWith("/SKILL.md") ? "unclassified" : "not emitted" };
    if (exclude.some(pattern => pattern.test(path))) return { kind: "excluded" };
    const entry = source.map.find(({ from }) => from.endsWith("/") ? path.startsWith(from) : path === from);
    if (!entry) return { kind: "not emitted" };
    const mapped = entry.to + path.slice(entry.from.length);
    const output = row ? mapped.replace(/^skills\/[^/]+\//, `skills/${row.name}/`) : mapped;
    return { kind: "emitted", output };
  };
}

/** Notes when a changed upstream path is an idea p3stack borrowed in its own words (rules/borrowed.json). */
export function borrowedNote(borrowed, source, path) {
  const entry = (borrowed ?? []).find(row => row.source === source && row.path === path);
  return entry ? ` [borrowed by ${entry.by.join(", ")}: review whether the borrowed idea changed]` : "";
}
