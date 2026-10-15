import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_PROMPT, useOwnSystemPrompt, type SystemPromptChoice } from "../extensions/claude-subscription/src/prompt.js";

/** Pi does not export its prompt builder. Resolve the public entry, then the file beside it. */
const { buildSystemPrompt } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as { buildSystemPrompt: (input: PromptInput) => string };

interface PromptInput extends SystemPromptChoice {
  cwd: string;
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
  assert.doesNotMatch(prompt, /operating inside pi|coding agent harness|Pi documentation/i);
  assert.match(prompt, /<addendum>\nKeep edits on a worktree\.\n<\/addendum>/);
  assert.match(prompt, /<project_context>[\s\S]*This repository is pi-packages\.[\s\S]*<\/project_context>/);
  assert.match(prompt, /<skills>[\s\S]*<name>review<\/name>[\s\S]*<\/skills>/);
  assert.match(prompt, /<cwd>\n\/work\/pi-packages\n<\/cwd>/);
});

test("what tools and extensions tell the model about themselves is still sent", () => {
  const stock = buildSystemPrompt(options());
  const section = (prompt: string, name: string): string => new RegExp(`<${name}>\n([\\s\\S]*?)\n</${name}>`).exec(prompt)?.[1] ?? "";

  // Pi drops its tool list and rules whenever the preamble is replaced; they come back as sections, word for word.
  const input = options();
  useOwnSystemPrompt(input, "claude-subscription");
  const prompt = buildSystemPrompt(input);
  assert.equal(section(prompt, "tools"), section(stock, "tools"));
  assert.equal(section(prompt, "rules"), section(stock, "rules"));
  assert.match(section(prompt, "tools"), /^- read: Read file contents\n- bash: Execute bash commands\n\nIn addition to the tools above/);
  assert.match(section(prompt, "rules"), /- Use read to examine files instead of cat or sed\.\n- Show your work\.\n- Be concise/);

  // A tool that is only reachable through another one is left out, as newer Pi releases leave it out.
  const hidden = options({ hiddenTools: ["bash"] });
  useOwnSystemPrompt(hidden, "claude-subscription");
  const hiddenPrompt = buildSystemPrompt(hidden);
  assert.match(section(hiddenPrompt, "tools"), /^- read: Read file contents\n\nIn addition/);
  assert.doesNotMatch(section(hiddenPrompt, "rules"), /Use bash for file operations/);

  // Sections an extension already supplied are its own to word.
  const supplied = options({ sections: { rules: "Only these." } });
  useOwnSystemPrompt(supplied, "claude-subscription");
  assert.equal(section(buildSystemPrompt(supplied), "rules"), "Only these.");
  assert.match(SYSTEM_PROMPT, /`read` is `mcp__pi__read`/);
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

test("host guidance composes with the provider prompt when sections or provider-first ordering are used", () => {
  const guidance = "Use the host's orchestration tools for delegated work.";
  // This is the full-prompt return used by T3's before_agent_start handler.
  const freeze = (input: PromptInput): void => {
    input.forceSystemPrompt = `${buildSystemPrompt(input)}\n\n${guidance}`;
  };

  const hostFirst = options();
  freeze(hostFirst);
  useOwnSystemPrompt(hostFirst, "claude-subscription");
  assert.match(buildSystemPrompt(hostFirst), new RegExp(escape(STOCK)), "an earlier forced prompt is intentionally respected");

  const providerFirst = options();
  useOwnSystemPrompt(providerFirst, "claude-subscription");
  freeze(providerFirst);
  const rendered = buildSystemPrompt(providerFirst);
  assert.ok(rendered.startsWith(SYSTEM_PROMPT));
  assert.ok(rendered.endsWith(guidance));
  assert.match(rendered, /This repository is pi-packages/);

  for (const hostFirst of [true, false]) {
    const input = options();
    const addSection = (): void => { (input.sections ??= {}).t3_orchestration = guidance; };
    if (hostFirst) addSection();
    useOwnSystemPrompt(input, "claude-subscription");
    if (!hostFirst) addSection();
    const prompt = buildSystemPrompt(input);
    assert.ok(prompt.startsWith(SYSTEM_PROMPT));
    assert.ok(prompt.includes(`<t3_orchestration>\n${guidance}\n</t3_orchestration>`));
    assert.match(prompt, /This repository is pi-packages/);
    assert.equal(input.forceSystemPrompt, undefined);
  }
});
