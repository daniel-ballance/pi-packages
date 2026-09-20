import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Both subscriptions are already authenticated by Pi itself, so this reads
 * Pi's own credential store rather than introducing a second token path.
 *
 *   ~/.pi/agent/auth.json
 *     openai-codex: { type: "oauth", access, accountId }  -> ChatGPT Pro
 *     xai:          { type: "oauth", access }             -> SuperGrok
 */

export type PiCredentials = {
  chatgpt?: { accessToken: string; accountId: string };
  supergrok?: { accessToken: string };
};

export function defaultAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readCredentials(
  options: { path?: string; readFile?: (p: string) => string } = {},
): PiCredentials {
  const path = options.path ?? defaultAuthPath();
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const store = raw as Record<string, unknown>;

  const out: PiCredentials = {};

  const codex = store["openai-codex"];
  if (codex && typeof codex === "object") {
    const entry = codex as Record<string, unknown>;
    const access = nonEmpty(entry.access);
    const accountId = nonEmpty(entry.accountId);
    if (access && accountId && entry.type === "oauth") {
      out.chatgpt = { accessToken: access, accountId };
    }
  }

  const xai = store.xai;
  if (xai && typeof xai === "object") {
    const entry = xai as Record<string, unknown>;
    const access = nonEmpty(entry.access);
    if (access && entry.type === "oauth") {
      out.supergrok = { accessToken: access };
    }
  }

  return out;
}
