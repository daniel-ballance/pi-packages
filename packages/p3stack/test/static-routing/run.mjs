#!/usr/bin/env node
// Tier A routing check: ranks realistic prompts against the descriptions of
// p3stack's model-invoked skills with TF-IDF and cosine similarity. Free,
// deterministic, and run by `npm run check`. Semantic routing is the routing
// eval's job (test/routing-eval); this catches missing vocabulary and
// descriptions that collide.
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const STOP = new Set("a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our should so that the their them then there these this to use used uses using want was we what when where which while who why will with you your skill skills".split(" "));

export function stem(word) {
  for (const suffix of ["ations", "ation", "ings", "ing", "ies", "ied", "edly", "ed", "es", "ly", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) return suffix === "ies" || suffix === "ied" ? word.slice(0, -3) + "y" : word.slice(0, -suffix.length);
  }
  return word;
}

export const tokens = text => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word && !STOP.has(word)).map(stem);

/** Builds an index over `{name, text}` documents and returns a scorer. */
export function index(documents) {
  const docs = documents.map(({ name, text }) => ({ name, terms: tokens(`${name.replaceAll("-", " ")} ${text}`) }));
  const df = new Map();
  for (const { terms } of docs) for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = term => Math.log((docs.length + 1) / ((df.get(term) ?? 0) + 1)) + 1;
  const vector = terms => {
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    const weights = new Map([...counts].map(([term, count]) => [term, (count / terms.length) * idf(term)]));
    const norm = Math.sqrt([...weights.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
    return new Map([...weights].map(([term, value]) => [term, value / norm]));
  };
  const cosine = (a, b) => { let sum = 0; for (const [term, value] of a) sum += value * (b.get(term) ?? 0); return sum; };
  const vectors = docs.map(doc => ({ name: doc.name, vector: vector(doc.terms) }));
  return {
    rank: prompt => {
      const query = vector(tokens(prompt));
      return vectors.map(({ name, vector }) => ({ name, score: cosine(query, vector) })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    },
    collisions: threshold => {
      const pairs = [];
      for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) {
        const score = cosine(vectors[i].vector, vectors[j].vector);
        if (score >= threshold) pairs.push({ a: vectors[i].name, b: vectors[j].name, score });
      }
      return pairs.sort((a, b) => b.score - a.score);
    },
  };
}

/** Reads the model-invoked skills' descriptions from the registry and the generated output. */
export function modelInvokedSkills(packageDir) {
  const registry = JSON.parse(readFileSync(join(packageDir, "registry/skills.json"), "utf8"));
  const paths = registry.filter(row => row.action === "emit" && row.invocation === "model")
    .map(row => join(packageDir, "skills", row.name, "SKILL.md"));
  const nested = join(packageDir, "subagents/skills");
  for (const entry of readdirSync(nested, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(join(nested, entry.name, "SKILL.md"));
  }
  return paths.flatMap(path => {
    const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"));
    if (frontmatter["disable-model-invocation"]) return [];
    const { name, description } = frontmatter;
    if (!name || typeof description !== "string" || !description.trim()) throw new Error(`Missing name or description in ${path}`);
    return [{ name, text: description.trim() }];
  });
}

export function evaluate(skills, suite) {
  const known = new Set(skills.map(skill => skill.name)), scorer = index(skills);
  const failures = [], firsts = [], covered = new Set(), pending = new Set(suite.pending);
  let negatives = 0;
  for (const entry of suite.cases) {
    for (const { owner } of entry.negative ?? []) {
      if (owner !== undefined && !known.has(owner)) failures.push(`negative ${entry.skill}: unknown owner ${owner}`);
    }
    if (!known.has(entry.skill)) {
      if (!pending.has(entry.skill)) failures.push(`unknown case skill ${entry.skill}`);
      continue;
    }
    for (const { prompt, top_k = 3 } of entry.positive ?? []) {
      const ranked = scorer.rank(prompt), position = ranked.findIndex(row => row.name === entry.skill) + 1;
      covered.add(entry.skill);
      firsts.push(position === 1);
      if (position > top_k) failures.push(`positive ${entry.skill}: rank ${position} > ${top_k} for "${prompt}" (top: ${ranked.slice(0, 3).map(row => row.name).join(", ")})`);
    }
    for (const { prompt, owner } of entry.negative ?? []) {
      const ranked = scorer.rank(prompt), position = name => ranked.findIndex(row => row.name === name) + 1;
      negatives++;
      if (owner !== undefined) {
        if (!known.has(owner)) continue;
        if (position(owner) > position(entry.skill)) failures.push(`negative ${entry.skill}: owner ${owner} ranks ${position(owner)} below ${entry.skill} at ${position(entry.skill)} for "${prompt}"`);
      } else if (position(entry.skill) === 1) failures.push(`negative ${entry.skill}: ranks first for "${prompt}"`);
    }
  }
  for (const name of known) {
    if (!covered.has(name) && !pending.has(name)) failures.push(`no positive case for ${name}`);
  }
  if (!firsts.length) failures.push("no positive prompts evaluated");
  const first = firsts.filter(Boolean).length, rankOne = firsts.length ? first / firsts.length : 0;
  if (rankOne < suite.rankOneFloor) failures.push(`rank-1 share ${(rankOne * 100).toFixed(1)}% is below the floor ${(suite.rankOneFloor * 100).toFixed(1)}%`);
  const collisions = scorer.collisions(suite.collisionThreshold);
  for (const { a, b, score } of collisions) failures.push(`collision ${a} ~ ${b}: ${score.toFixed(2)} >= ${suite.collisionThreshold}`);
  return { failures, covered: covered.size, first, rankOne, positives: firsts.length, negatives, top: scorer.collisions(0).slice(0, 3) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packageDir = resolve(here, "../..");
  const suite = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
  const skills = modelInvokedSkills(packageDir);
  const result = evaluate(skills, suite);
  const closest = result.top.map(({ a, b, score }) => `${a} ~ ${b} ${score.toFixed(2)}`).join("; ");
  console.log(`description lint: ${result.covered}/${skills.length} model-invoked skills with positives; rank-1 ${result.first}/${result.positives}; ${result.negatives} negatives; closest descriptions: ${closest}`);
  if (suite.pending.length) console.log(`pending: ${suite.pending.join(", ")}`);
  for (const failure of result.failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(result.failures.length ? 1 : 0);
}
