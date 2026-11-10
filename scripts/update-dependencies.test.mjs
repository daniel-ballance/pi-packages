import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChanges, planManifest, targetSpec } from "./update-dependencies.mjs";

test("registry ranges move to a caret on npm latest", () => {
  for (const spec of ["1.3.0", "^1.3.0", "~1.3.0", ">=1.3.0", "1"]) assert.equal(targetSpec(spec, "1.5.2"), "^1.5.2", spec);
});

test("wildcards, local, git and tag specs are left alone", () => {
  for (const spec of ["*", "", "file:../x", "workspace:*", "link:../x", "github:a/b", "git+https://x/y.git", "latest", "npm:other@1.0.0"]) {
    assert.equal(targetSpec(spec, "1.5.2"), undefined, spec);
  }
});

test("a prerelease or malformed latest is refused", () => {
  for (const latest of ["2.0.0-beta.1", "2.0", ""]) assert.throws(() => targetSpec("1.0.0", latest), /prerelease or malformed/);
});

test("the plan covers dependency sections, skips peers, and is empty once current", () => {
  const latest = { a: "2.0.0", b: "3.1.0", c: "1.0.0", d: "9.9.9" };
  const manifest = {
    dependencies: { a: "1.0.0" },
    devDependencies: { b: "^3.1.0", c: "*" },
    optionalDependencies: { d: "~9.0.0" },
    peerDependencies: { a: ">=1.0.0" },
  };
  const changes = planManifest(manifest, name => latest[/** @type {keyof typeof latest} */ (name)]);
  assert.deepEqual(changes.map(change => `${change.section}:${change.name}:${change.to}`), ["dependencies:a:^2.0.0", "optionalDependencies:d:^9.9.9"]);
  assert.deepEqual(planManifest({ dependencies: { a: "^2.0.0" } }, () => "2.0.0"), []);
});

test("a rewrite touches only the spec in its section and keeps the formatting", () => {
  const text = '{\n  "files": ["a", "b"],\n  "peerDependencies": { "x": "1.0.0" },\n  "devDependencies": {\n    "x": "1.0.0"\n  }\n}\n';
  const changes = planManifest(JSON.parse(text), () => "1.2.0");
  assert.equal(applyChanges(text, changes), text.replace('"x": "1.0.0"\n', '"x": "^1.2.0"\n'));
  assert.throws(() => applyChanges(text, [{ section: "dependencies", name: "x", from: "1.0.0", to: "^1.2.0" }]), /Cannot find/);
});
