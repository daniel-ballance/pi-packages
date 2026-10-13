import { PROVIDER_ID } from "./models.js";

/**
 * Identity used in place of Pi's default preamble while this provider is selected.
 * Pi still appends project context, skills, an appended prompt, and the working directory.
 */
export const SYSTEM_PROMPT = [
  "You are a coding assistant. The project in front of you is the work, and the tools you are given are how you read and change it.",
  "Look before you edit. Prefer a small, exact change over a rewrite. Say what you did in plain language, and name the files you touched.",
].join("\n\n");

/** The parts of Pi's prompt options this provider may replace. */
export interface SystemPromptChoice {
  customPrompt?: string;
  forceSystemPrompt?: string;
}

/**
 * Use this package's prompt when the selected model belongs to it and the user has not
 * already chosen one. `customPrompt` is the slot `SYSTEM.md` and `--system-prompt` fill,
 * so a prompt from either of those, or a forced prompt, is left as it was written.
 */
export function useOwnSystemPrompt(options: SystemPromptChoice, provider: string | undefined): void {
  if (provider !== PROVIDER_ID) return;
  if (options.customPrompt !== undefined || options.forceSystemPrompt !== undefined) return;
  options.customPrompt = SYSTEM_PROMPT;
}
