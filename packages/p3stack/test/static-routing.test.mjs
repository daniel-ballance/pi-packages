import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, index, stem, tokens } from "./static-routing/run.mjs";

const skills = [
  { name: "pr", text: "Use when writing a pull request description." },
  { name: "release", text: "Prepare release notes and a version bump." },
  { name: "tdd", text: "Test-driven development with red-green-refactor." },
];

test("tokens drop stop words and stem plural and -ing forms", () => {
  assert.deepEqual(tokens("Writing the tests for releases"), ["writ", "test", "releas"]);
  assert.equal(stem("libraries"), "library");
});

test("ranking puts the matching description first", () => {
  assert.equal(index(skills).rank("Cut a release and bump the version")[0].name, "release");
  assert.equal(index(skills).rank("Draft the pull request description")[0].name, "pr");
});

test("evaluate reports failing positives, outranked owners, low rank-1 share, collisions and unknown skills", () => {
  const suite = { rankOneFloor: 1, collisionThreshold: 0.99, cases: [
    { skill: "tdd", positive: [{ prompt: "Prepare release notes", top_k: 1 }], negative: [{ prompt: "red-green-refactor please", owner: "release" }] },
    { skill: "future-skill", positive: [{ prompt: "anything" }] },
  ] };
  const result = evaluate(skills, suite);
  assert.deepEqual(result.skipped, ["future-skill"]);
  assert.match(result.failures[0], /^positive tdd: rank 3 > 1/);
  assert.match(result.failures[1], /^negative tdd: owner release ranks/);
  assert.match(result.failures[2], /rank-1 share 0\.0% is below the floor 100\.0%/);
  const collided = evaluate([...skills, { name: "pr-copy", text: skills[0].text }], { rankOneFloor: 0, collisionThreshold: 0.7, cases: [] }).failures;
  assert.equal(collided.length, 1);
  assert.match(collided[0], /^collision pr ~ pr-copy: 0\.\d\d >= 0\.7$/);
});

test("a negative without an owner only requires the skill not to rank first", () => {
  const suite = { rankOneFloor: 0, collisionThreshold: 1.1, cases: [{ skill: "release", negative: [{ prompt: "release notes" }] }] };
  assert.equal(evaluate(skills, suite).failures.length, 1);
});
