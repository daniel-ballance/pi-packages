// Keep generation and the updater's review report on the same scope rules.
export function sourcePathClassifier(manifest) {
  const exclude = (manifest.exclude ?? []).map(source => new RegExp(source));
  return path => {
    if (exclude.some(pattern => pattern.test(path))) return { kind: "excluded" };
    const entry = manifest.map.find(({ from }) => from.endsWith("/") ? path.startsWith(from) : path === from);
    if (!entry) return { kind: "not emitted" };
    return { kind: "emitted", output: entry.to + path.slice(entry.from.length) };
  };
}
