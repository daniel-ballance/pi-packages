// Keep generation and the updater's review report on the same scope rules.
export function sourcePathClassifier(source) {
  const exclude = (source.exclude ?? []).map(pattern => new RegExp(pattern));
  return path => {
    if (exclude.some(pattern => pattern.test(path))) return { kind: "excluded" };
    const entry = source.map.find(({ from }) => from.endsWith("/") ? path.startsWith(from) : path === from);
    if (!entry) return { kind: "not emitted" };
    return { kind: "emitted", output: entry.to + path.slice(entry.from.length) };
  };
}
