import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SystemMessage } from "@earendil-works/pi-ai";

export function projectRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === dirname(dir)) return cwd;
  }
}

type Location = { cwd: string; root: string };
function projectContext(text: string, { cwd, root }: Location): string | undefined {
  const ownFiles = /\n*<project_instructions path="([^"\n]+)">\n[\s\S]*?\n<\/project_instructions>/g;
  function loadedHere(path: string): boolean {
    if (!isAbsolute(path) || !["AGENTS.md", "GEMINI.md"].includes(basename(path))) return false;
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      if (relative(dir, dirname(path)) === "") return true;
      if (dir === root || dir === dirname(dir)) return false;
    }
  }
  const filtered = text.replace(ownFiles, (block, path: string) => loadedHere(path) ? "" : block);
  return filtered === text || filtered.includes("<project_instructions ") ? filtered : undefined;
}

const PI_AGENT_IDENTITY = "You are a coding assistant running inside pi, a coding agent harness.";
const keep = (text: string) => text;
const omit = () => undefined;
const RULES = new Map<string, (text: string, loc: Location) => string | undefined>([
  ["preamble", omit], ["tools", omit], ["rules", omit], ["docs", omit], ["cwd", omit],
  ["addendum", keep], ["project_context", projectContext], ["skills", keep],
]);
export type Forwarded = readonly (readonly [name: string, text: string])[];

export function forwardedSections(system: SystemMessage | undefined, location: Location): Forwarded {
  const preamble = system?.sections?.preamble?.trim();
  return Object.entries(system?.sections ?? {}).flatMap(([name, text]) => {
    if (text === null || text.includes(PI_AGENT_IDENTITY) || (preamble && text.includes(preamble))) return [];
    const forwarded = (RULES.get(name) ?? keep)(text, location);
    return forwarded === undefined ? [] : [[name, forwarded] as const];
  });
}

export function runtimeNote(model: string): string {
  return `In case you're asked: you are running in Pi through the Antigravity CLI over ACP, as ${model}. No need to mention this otherwise. Use your own tools for files, commands and the web. Where Pi instructions name read, bash, edit or write, use your equivalents. Pi extension tools are available from the MCP server "pi". If a Pi tool you need is missing from your tool list, call call_pi_tool on that server with its name to get its schema, then again with args as a JSON object string ("{}" for none) to run it.`;
}

export function appendPrompt(model: string, sections: Forwarded): string {
  return [runtimeNote(model), ...sections.map(([, text]) => text)].join("\n\n");
}

export function instructionsUpdate(previous: Forwarded, next: Forwarded, updatedNote?: string): string | undefined {
  const earlier = new Map(previous);
  const current = new Map(next);
  const changes = next.filter(([name, text]) => earlier.get(name) !== text).map(([, text]) => text);
  const removed = previous.filter(([name]) => !current.has(name)).map(([name]) => name);
  return updatedNote || changes.length || removed.length ? ["[Pi updated these instructions; they supersede the corresponding earlier sections.]",
    ...(updatedNote ? [updatedNote] : []), ...removed.map(name => `[Pi removed the ${name} section.]`),
    ...changes, "[End of Pi updated instructions]"].join("\n\n") : undefined;
}
