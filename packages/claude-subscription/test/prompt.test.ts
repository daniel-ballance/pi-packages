import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeSubscription from "../extensions/claude-subscription/index.js";

/** Pi does not export its prompt builder. Resolve the public entry, then the file beside it. */
const { buildSystemPrompt } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as { buildSystemPrompt: (input: BuildSystemPromptOptions) => string };

const STOCK = "You are a coding assistant running inside pi, a coding agent harness.";

function options(extra: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
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
      baseDir: "/work/pi-packages/skills/review",
      sourceInfo: { path: "/work/pi-packages/skills/review/SKILL.md", source: "test", scope: "project", origin: "top-level" },
      disableModelInvocation: false,
    }],
    ...extra,
  };
}

/** Exercise any prompt hook the real extension registers, not a substitute prompt helper. */
function throughExtension(input: BuildSystemPromptOptions, provider?: string): string {
  type Handler = (event: { systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions }, ctx: { model: { provider: string } }) => { systemPrompt?: string } | void;
  const handlers: Handler[] = [];
  let registeredProvider = "";
  claudeSubscription({
    registerProvider(value: { id: string }) { registeredProvider = value.id; },
    registerCommand() {},
    on(event: string, handler: Handler) {
      if (event === "before_agent_start") handlers.push(handler);
    },
  } as unknown as ExtensionAPI);
  for (const handler of handlers) {
    const result = handler({ systemPrompt: buildSystemPrompt(input), systemPromptOptions: input }, { model: { provider: provider ?? registeredProvider } });
    if (result?.systemPrompt !== undefined) input.forceSystemPrompt = result.systemPrompt;
  }
  return buildSystemPrompt(input);
}

function unchanged(input: BuildSystemPromptOptions, provider?: string): string {
  const before = structuredClone(input);
  const expected = buildSystemPrompt(input);
  const prompt = throughExtension(input, provider);
  assert.deepEqual(input, before, "the provider leaves Pi's structured prompt inputs untouched");
  assert.equal(prompt, expected, "Pi renders the same prompt with or without the provider");
  return prompt;
}

test("the provider leaves Pi's stock prompt and project context intact", () => {
  const prompt = unchanged(options());
  assert.ok(prompt.startsWith(STOCK));
  assert.match(prompt, /Pi documentation/);
  assert.match(prompt, /<addendum>\nKeep edits on a worktree\.\n<\/addendum>/);
  assert.match(prompt, /<project_context>[\s\S]*This repository is pi-packages\.[\s\S]*<\/project_context>/);
  assert.match(prompt, /<skills>[\s\S]*<name>review<\/name>/);
  assert.match(prompt, /<cwd>\n\/work\/pi-packages\n<\/cwd>/);
});

test("Pi owns tool declarations, hidden tools and extension guidelines", () => {
  const prompt = unchanged(options());
  assert.match(prompt, /- read: Read file contents\n- bash: Execute bash commands/);
  assert.match(prompt, /Use read to examine files instead of cat or sed\./);
  assert.match(prompt, /Show your work\./);
  const hidden = unchanged(options({ hiddenTools: ["bash"] }));
  assert.doesNotMatch(hidden, /- bash: Execute bash commands|Use bash for file operations/);
  const supplied = unchanged(options({ sections: { rules: "Only these." } }));
  assert.match(supplied, /<rules>\nOnly these\.\n<\/rules>/);
});

test("custom, empty and forced prompts retain Pi's native semantics", () => {
  const chosen = unchanged(options({ customPrompt: "Follow the notes in AGENTS.md." }));
  assert.match(chosen, /^Follow the notes in AGENTS\.md\./);
  assert.match(chosen, /This repository is pi-packages/);
  assert.ok(unchanged(options({ customPrompt: "" })).startsWith(STOCK));
  assert.equal(unchanged(options({ forceSystemPrompt: "Exactly this." })), "Exactly this.");
});

test("switching providers does not change the prompt inputs", () => {
  const input = options();
  const prompt = unchanged(input);
  assert.equal(unchanged(input, "anthropic"), prompt);
  assert.equal(unchanged(input), prompt);
});

test("host prompt guidance composes in either extension order", () => {
  const guidance = "Use the host's orchestration tools for delegated work.";
  for (const hostFirst of [true, false]) {
    const input = options();
    if (!hostFirst) unchanged(input);
    input.forceSystemPrompt = `${buildSystemPrompt(input)}\n\n${guidance}`;
    const forced = unchanged(input);
    assert.ok(forced.startsWith(STOCK));
    assert.ok(forced.endsWith(guidance));
    assert.match(forced, /This repository is pi-packages/);

    const structured = options();
    if (!hostFirst) unchanged(structured);
    structured.sections = { t3_orchestration: guidance };
    const prompt = unchanged(structured);
    assert.ok(prompt.startsWith(STOCK));
    assert.match(prompt, /<t3_orchestration>\nUse the host's orchestration tools for delegated work\.\n<\/t3_orchestration>/);
    assert.equal(structured.forceSystemPrompt, undefined);
  }
});
