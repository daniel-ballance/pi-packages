import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_PROMPT, useOwnSystemPrompt, type SystemPromptChoice } from "../extensions/claude-subscription/src/prompt.js";

/** Pi does not export its prompt builder. Resolve the public entry, then the file beside it. */
const { buildSystemPrompt } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as { buildSystemPrompt: (input: PromptInput) => string };

interface PromptInput extends SystemPromptChoice {
  cwd: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  toolGuidelines?: Record<string, string[]>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Array<{ name: string; description: string; filePath: string; disableModelInvocation: boolean }>;
}

const STOCK = "You are an expert coding assistant operating inside pi, a coding agent harness.";

function options(extra: Partial<PromptInput> = {}): PromptInput {
  return {
    cwd: "/work/pi-packages",
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
    toolGuidelines: { read: ["Use read to examine files instead of cat or sed."] },
    promptGuidelines: ["Show your work."],
    appendSystemPrompt: "Keep edits on a worktree.",
    contextFiles: [{ path: "/work/pi-packages/AGENTS.md", content: "This repository is pi-packages." }],
    skills: [{
      name: "review",
      description: "Review a change.",
      filePath: "/work/pi-packages/skills/review/SKILL.md",
      disableModelInvocation: false,
    }],
    ...extra,
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the rendered prompt is this package's own, and still carries the project around it", () => {
  const input = options();
  const stock = buildSystemPrompt(input);
  assert.match(stock, new RegExp(escape(STOCK)));
  assert.match(stock, /Pi documentation/);
  assert.match(stock, /Use read to examine files instead of cat or sed/);
  assert.match(stock, /- read: Read file contents/);

  useOwnSystemPrompt(input, "claude-subscription");
  const prompt = buildSystemPrompt(input);
  assert.match(prompt, new RegExp(`^${escape(SYSTEM_PROMPT)}`));
  assert.doesNotMatch(prompt, /operating inside pi|coding agent harness|Pi documentation|In addition to the tools above/i);
  assert.doesNotMatch(prompt, /Use read to examine files instead of cat or sed/);
  assert.doesNotMatch(prompt, /Show your work/);
  assert.doesNotMatch(prompt, /- read: Read file contents/);
  assert.match(prompt, /<addendum>\nKeep edits on a worktree\.\n<\/addendum>/);
  assert.match(prompt, /<project_context>[\s\S]*This repository is pi-packages\.[\s\S]*<\/project_context>/);
  assert.match(prompt, /<skills>[\s\S]*<name>review<\/name>[\s\S]*<\/skills>/);
  assert.match(prompt, /<cwd>\n\/work\/pi-packages\n<\/cwd>/);
});

test("a prompt the user wrote is rendered unchanged, and an empty one is left for Pi", () => {
  const chosen = options({ customPrompt: "Follow the notes in AGENTS.md." });
  useOwnSystemPrompt(chosen, "claude-subscription");
  const prompt = buildSystemPrompt(chosen);
  assert.match(prompt, /^Follow the notes in AGENTS\.md\./);
  assert.doesNotMatch(prompt, /operating inside pi/);
  assert.match(prompt, /This repository is pi-packages/);
  assert.match(prompt, /<cwd>\n\/work\/pi-packages\n<\/cwd>/);

  // Pi treats an empty custom prompt as "no custom prompt" and builds its default.
  const empty = options({ customPrompt: "" });
  useOwnSystemPrompt(empty, "claude-subscription");
  assert.equal(empty.customPrompt, "");
  assert.match(buildSystemPrompt(empty), new RegExp(escape(STOCK)));

  const forced = options({ forceSystemPrompt: "Exactly this." });
  useOwnSystemPrompt(forced, "claude-subscription");
  assert.equal(buildSystemPrompt(forced), "Exactly this.");
});

test("another provider still gets Pi's default prompt", () => {
  const input = options();
  useOwnSystemPrompt(input, "anthropic");
  const prompt = buildSystemPrompt(input);
  assert.match(prompt, new RegExp(escape(STOCK)));
  assert.match(prompt, /Pi documentation/);
  assert.match(prompt, /<skills>[\s\S]*<name>review<\/name>/);
  assert.match(prompt, /<cwd>\n\/work\/pi-packages\n<\/cwd>/);
});
