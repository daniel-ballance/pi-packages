#!/usr/bin/env node
// Package maintenance adapter; the public CLI intentionally has no discovery mode.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skills = join(root, 'skills');
const directories = readdirSync(skills, { withFileTypes: true })
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
    join(root, 'scripts/lint-skill.mjs'), '--resource-root', skills, ...directories,
  ], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 2;
}
