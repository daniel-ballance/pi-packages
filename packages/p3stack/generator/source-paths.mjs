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
  const exclude = (source.exclude ?? []).map(pattern => new RegExp(pattern));
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
