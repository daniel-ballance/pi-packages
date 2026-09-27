import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lintSkill } from '../lib/lint-skill.mjs';

function skillFixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'lint-skill-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = join(root, 'example');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), source);
  return skill;
}

test('protocol-relative URLs stay URLs in depth diagnostics', (t) => {
  const skill = skillFixture(t, '---\nname: example\ndescription: Useful instructions.\n---\n[first](one.md)\n');
  writeFileSync(join(skill, 'one.md'), '[second](two.md)\n');
  writeFileSync(join(skill, 'two.md'), '[external](//example.test/docs)\n');
  const report = lintSkill(skill);
  const finding = report.findings.find((item) => item.ruleId === 'resources/depth');
  assert.equal(finding.path, join(skill, 'two.md'));
  assert.equal(finding.route.at(-1), '//example.test/docs');
  assert.equal(finding.depth, 3);
});

test('shallow outside-root references are unverified dependencies, not automatic warnings', (t) => {
  const skill = skillFixture(t, '---\nname: example\ndescription: Useful instructions.\n---\n[shared](../unverified.md)\n');
  const report = lintSkill(skill);
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.dependencies.length, 1);
  assert.equal(report.dependencies[0].status, 'unverified');
  assert.equal(report.dependencies[0].target, join(skill, '../unverified.md'));
});

test('Pi UTF-16 diagnostics apply to description, not ignored compatibility metadata', (t) => {
  const skill = skillFixture(t, `---\nname: example\ndescription: ${'😀'.repeat(600)}\ncompatibility: ${'😀'.repeat(300)}\n---\nBody.\n`);
  const report = lintSkill(skill);
  const findings = report.findings.filter((finding) => finding.ruleId === 'pi/utf16-length');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /description/);
  assert.equal(findings[0].line, 3);
});

test('unresolved YAML tags cannot bypass the custom-tag policy using the standard namespace', (t) => {
  const skill = skillFixture(t, '---\nname: !!foo example\ndescription: Useful instructions.\n---\nBody.\n');
  const report = lintSkill(skill);
  assert.equal(report.complete, true);
  assert.ok(report.findings.some((finding) =>
    finding.ruleId === 'frontmatter/tag' && finding.severity === 'error' && finding.category === 'authoring'));
});
