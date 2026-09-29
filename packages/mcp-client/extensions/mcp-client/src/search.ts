export function searchScore(
  query: string,
  server: string,
  name: string,
  title: string,
  description: string,
): number {
  const normalize = (value: string) => value.toLowerCase().replace(/[_-]+/g, ' ').trim();
  const q = normalize(query);
  if (!q) return 0;
  const n = normalize(name),
    t = normalize(title),
    d = normalize(description),
    s = normalize(server);
  const terms = q.split(/\s+/);
  return (
    (q === n ? 100 : 0) +
    (q === t ? 80 : 0) +
    terms.reduce(
      (score, term) =>
        score +
        (n.includes(term) ? 8 : 0) +
        (t.includes(term) ? 4 : 0) +
        (d.includes(term) ? 1 : 0) +
        (s.includes(term) ? 1 : 0),
      0,
    )
  );
}
