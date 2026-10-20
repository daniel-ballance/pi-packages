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

export function sourcePathClassifier(source) {
  const exclude = (source.exclude ?? []).map(pattern => new RegExp(pattern));
  return path => {
    if (exclude.some(pattern => pattern.test(path))) return { kind: "excluded" };
    const entry = source.map.find(({ from }) => from.endsWith("/") ? path.startsWith(from) : path === from);
    if (!entry) return { kind: "not emitted" };
    return { kind: "emitted", output: entry.to + path.slice(entry.from.length) };
  };
}
