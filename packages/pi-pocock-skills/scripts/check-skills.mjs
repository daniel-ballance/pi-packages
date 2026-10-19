#!/usr/bin/env node
// Package maintenance adapter for the repository's lint-skill CLI, which
// intentionally has no discovery mode.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: node scripts/check-skills.mjs [skills-dir]');
  process.exit(2);
}

const skills = resolve(args[0] ?? join(root, 'skills'));
let entries;
try {
  entries = readdirSync(skills, { withFileTypes: true });
} catch (error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    console.error(`Skill directory not found: ${skills}`);
    process.exit(2);
  }
  throw error;
}

const directories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(skills, entry.name))
  .filter((directory) => {
    try {
      return statSync(join(directory, 'SKILL.md')).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  })
  .sort();

if (directories.length === 0) {
  console.error('No skill directories found; refusing an empty lint check.');
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [
    join(root, '../../scripts/lint-skill/lint-skill.mjs'), '--resource-root', skills, ...directories,
  ], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 2;
}
