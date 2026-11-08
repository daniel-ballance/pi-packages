#!/usr/bin/env node
// Fills a p3stack workflow template. Placeholders are {{name}} inside JSON
// strings, and "{{name:number}}" for a whole numeric value. A placeholder left
// unfilled is an error. subagent_workflow_start validates the result in full.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const NUMBER = /"\{\{([A-Za-z][\w-]*):number\}\}"/g, TEXT = /\{\{([A-Za-z][\w-]*)\}\}/g;

export function placeholders(template) {
  return [...new Set([...template.matchAll(NUMBER), ...template.matchAll(TEXT)].map(match => match[1]))].sort();
}

export function instantiate(template, values) {
  const missing = placeholders(template).filter(name => !(name in values));
  if (missing.length) throw new Error(`Unfilled placeholders: ${missing.join(", ")}`);
  const unused = Object.keys(values).filter(name => !placeholders(template).includes(name));
  if (unused.length) throw new Error(`Unknown placeholders: ${unused.join(", ")}`);
  const filled = template
    .replace(NUMBER, (_, name) => {
      const value = Number(values[name]);
      if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
      return String(value);
    })
    .replace(TEXT, (_, name) => JSON.stringify(String(values[name])).slice(1, -1));
  return JSON.parse(filled);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { set: { type: "string", multiple: true }, out: { type: "string" }, list: { type: "boolean" } } });
    if (positionals.length !== 1) throw new Error("Usage: workflow-template <template.json> [--list] [--set name=value ...] [--out file]");
    const template = readFileSync(positionals[0], "utf8");
    if (values.list) { process.stdout.write(placeholders(template).join("\n") + "\n"); process.exit(0); }
    const settings = Object.fromEntries((values.set ?? []).map(pair => {
      const at = pair.indexOf("=");
      if (at <= 0) throw new Error(`--set needs name=value, got ${pair}`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }));
    const text = JSON.stringify(instantiate(template, settings), null, 2) + "\n";
    if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
  } catch (error) {
    process.stderr.write(`workflow-template: ${error.message}\n`);
    process.exit(2);
  }
}
