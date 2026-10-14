import { PROVIDER_ID } from "./models.js";
import { SERVER_NAME } from "./tools.js";

/**
 * Identity used in place of Pi's default preamble while this provider is selected.
 * Pi still appends project context, skills, an appended prompt, and the working directory.
 */
export const SYSTEM_PROMPT = [
  "You are a coding assistant. The project in front of you is the work, and the tools you are given are how you read and change it.",
  "Look before you edit. Prefer a small, exact change over a rewrite. Say what you did in plain language, and name the files you touched.",
  `Your tools are listed to you with an \`mcp__${SERVER_NAME}__\` prefix. Instructions, skills and the user name them without it: \`read\` is \`mcp__${SERVER_NAME}__read\`. When you mention a tool, use its name without the prefix.`,
].join("\n\n");

/** The parts of Pi's prompt options this provider reads and may replace. */
export interface SystemPromptChoice {
  customPrompt?: string;
  forceSystemPrompt?: string;
  selectedTools?: string[];
  hiddenTools?: string[];
  toolSnippets?: Record<string, string>;
  toolGuidelines?: Record<string, string[]>;
  promptGuidelines?: string[];
  sections?: Record<string, string>;
}

/** Pi's tool list, as its default prompt words it. */
function toolList(tools: readonly string[], snippets: Record<string, string>): string {
  const listed = tools.filter(name => snippets[name]).map(name => `- ${name}: ${snippets[name]}`);
  return `${listed.length ? listed.join("\n") : "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
}

/** Pi's rules, in its order: file-search advice, each tool's guidelines, then extension guidelines. */
function rules(tools: readonly string[], guidelines: Record<string, string[]>, extra: readonly string[]): string {
  const seen = new Set<string>();
  const add = (rule: string): void => {
    if (rule.trim()) seen.add(rule.trim());
  };
  const has = (name: string): boolean => tools.includes(name);
  if ((has("bash") || has("powershell")) && !has("grep") && !has("find") && !has("ls")) {
    if (has("bash") && has("powershell")) add("Use bash or PowerShell for file operations like listing, searching, and finding files");
    else if (has("powershell")) add("Use PowerShell for file operations like listing, searching, and finding files");
    else add("Use bash for file operations like ls, rg, find");
  }
  for (const name of tools) for (const rule of guidelines[name] ?? []) add(rule);
  for (const rule of extra) add(rule);
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return [...seen].map(rule => `- ${rule}`).join("\n");
}

/**
 * Add a section whose text is worked out when Pi reads it, which is when it builds the
 * prompt: after every extension's handler has run, so a tool or guideline one of them adds
 * later is still in it. A handler that assigns the section itself replaces it.
 */
function lateSection(sections: Record<string, string>, name: string, text: () => string): void {
  if (name in sections) return;
  Object.defineProperty(sections, name, {
    enumerable: true,
    configurable: true,
    get: text,
    set(value: string) {
      Object.defineProperty(sections, name, { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

/**
 * Use this package's prompt when the selected model belongs to it and the user has not
 * already chosen one. `customPrompt` is the slot `SYSTEM.md` and `--system-prompt` fill,
 * so a prompt from either of those, or a forced prompt, is left as it was written.
 *
 * Pi leaves its tool list and rules out whenever that slot is filled. They are how tools
 * and extensions tell the model how to use them, so they are put back as sections, where
 * Pi keeps them current as the tool set changes.
 */
export function useOwnSystemPrompt(options: SystemPromptChoice, provider: string | undefined): void {
  if (provider !== PROVIDER_ID) return;
  if (options.customPrompt !== undefined || options.forceSystemPrompt !== undefined) return;
  options.customPrompt = SYSTEM_PROMPT;
  const declared = (): string[] => {
    const hidden = options.hiddenTools ?? [];
    return (options.selectedTools ?? []).filter(name => !hidden.includes(name));
  };
  const sections = options.sections ??= {};
  lateSection(sections, "tools", () => toolList(declared(), options.toolSnippets ?? {}));
  lateSection(sections, "rules", () => rules(declared(), options.toolGuidelines ?? {}, options.promptGuidelines ?? []));
}
