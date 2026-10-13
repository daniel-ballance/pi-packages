import { createHash } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  renderSystemMessageUpdate,
  toToolDeclaration,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type SystemMessage,
  type TextContent,
  type Tool,
  type ToolResultMessage,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.js";

/** Content blocks the Agent SDK accepts in a user turn. */
export type UserBlock = Extract<Exclude<SDKUserMessage["message"]["content"], string>[number], { type: "text" | "image" }>;

/** One transcript message after the leading system message, with a stable identity. */
export type Entry =
  | { kind: "system"; key: string; message: SystemMessage }
  | { kind: "user"; key: string; message: UserMessage }
  | { kind: "assistant"; key: string; message: AssistantMessage }
  | { kind: "toolResult"; key: string; message: ToolResultMessage };

/** Pi's request as this provider compares and replays it. */
export interface Transcript {
  /** Prompt after replaying every system message; a new Claude Code session starts from it. */
  systemPrompt: string;
  /** Identity of the leading system message alone; later system messages are entries. */
  leadingKey: string;
  tools: Tool[];
  toolsKey: string;
  entries: Entry[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function contentIdentity(content: string | readonly (TextContent | ImageContent)[]): unknown {
  if (typeof content === "string") return [content];
  return content.map(block => block.type === "text" ? block.text : { image: digest(block.data), mimeType: block.mimeType });
}

/**
 * Identity of an assistant message. Responses this provider produced are named by their
 * Anthropic message id, which is how a live session recognises its own turns when Pi
 * sends them back; anything else is identified by what it said and called.
 */
export function assistantKey(message: AssistantMessage): string {
  if (message.provider === PROVIDER_ID && message.responseId) return `a:${message.responseId}`;
  return `a:${digest(message.content.flatMap((block): unknown[] => block.type === "text" ? [block.text]
    : block.type === "toolCall" ? [{ id: block.id, name: block.name, arguments: block.arguments }] : []))}`;
}

/** Read Pi's request; `withTools: false` honours a request that forbids tool calls. */
export function readTranscript(context: TranscriptContext, withTools = true): Transcript {
  const leading = getInitialSystemMessage(context.messages);
  const tools = withTools ? getCurrentTools(context.messages) : [];
  const entries: Entry[] = [];
  const answerable = new Set<string>();
  const messages: Message[] = leading ? context.messages.slice(1) : context.messages;
  for (const message of messages) {
    if (message.role === "system") {
      entries.push({ kind: "system", key: `s:${digest(renderSystemMessageUpdate(message))}`, message });
    } else if (message.role === "user") {
      entries.push({ kind: "user", key: `u:${digest(contentIdentity(message.content))}`, message });
    } else if (message.role === "assistant") {
      // Failed turns are incomplete; like Pi's own adapters, never replay them.
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const block of message.content) if (block.type === "toolCall") answerable.add(block.id);
      entries.push({ kind: "assistant", key: assistantKey(message), message });
    } else if (answerable.has(message.toolCallId)) {
      entries.push({
        kind: "toolResult",
        key: `t:${message.toolCallId}:${digest([contentIdentity(message.content), message.isError])}`,
        message,
      });
    }
  }
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    leadingKey: digest(leading ? getSystemMessageText(leading) : ""),
    tools,
    toolsKey: digest(tools.map(toToolDeclaration)),
    entries,
  };
}

const EMPTY = "(no content)";

type ImageType = Extract<Extract<UserBlock, { type: "image" }>["source"], { type: "base64" }>["media_type"];
const IMAGE_TYPES: readonly ImageType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function isImageType(value: string): value is ImageType {
  return IMAGE_TYPES.some(type => type === value);
}

function userBlocks(content: string | readonly (TextContent | ImageContent)[]): UserBlock[] {
  const blocks: UserBlock[] = [];
  for (const block of typeof content === "string" ? [{ type: "text" as const, text: content }] : content) {
    if (block.type === "image") {
      if (isImageType(block.mimeType)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
      } else blocks.push({ type: "text", text: `(image of unsupported type ${block.mimeType} omitted)` });
    } else if (block.text.trim()) blocks.push({ type: "text", text: block.text });
  }
  return blocks.length ? blocks : [{ type: "text", text: EMPTY }];
}

/** A later system message, delivered in the only channel the Agent SDK offers for a running session. */
function systemUpdateBlock(message: SystemMessage): UserBlock {
  return { type: "text", text: `<system-reminder>\n${renderSystemMessageUpdate(message)}\n</system-reminder>` };
}

/** New user and system entries as the content of one user turn. */
export function inputBlocks(entries: readonly Entry[]): UserBlock[] {
  return entries.flatMap(entry => entry.kind === "user" ? userBlocks(entry.message.content)
    : entry.kind === "system" ? [systemUpdateBlock(entry.message)] : []);
}

export function toolResult(message: ToolResultMessage): CallToolResult {
  const content: CallToolResult["content"] = [];
  for (const block of message.content) {
    if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.text.trim()) content.push({ type: "text", text: block.text });
  }
  if (!content.length) content.push({ type: "text", text: "(no output)" });
  return { content, isError: message.isError };
}

const HISTORY_PREAMBLE = [
  "This conversation began before the current session and is replayed here as a record.",
  "Everything inside <conversation-history> already happened: the tool calls were executed and their results are final.",
  "The record is not a format to imitate. To call a tool now, call it the normal way.",
].join(" ");

/**
 * Seed for a session that has no live history: earlier turns as a tagged record, then
 * the trailing user input as written. Images keep their place between the text around them.
 */
export function seedBlocks(entries: readonly Entry[]): UserBlock[] {
  let live = entries.length;
  while (live > 0 && (entries[live - 1].kind === "user" || entries[live - 1].kind === "system")) live--;
  if (!entries.slice(live).some(entry => entry.kind === "user")) live = entries.length;
  const past = entries.slice(0, live);
  const blocks: UserBlock[] = [];
  if (past.length) {
    let text = `${HISTORY_PREAMBLE}\n\n<conversation-history>\n`;
    const flush = (): void => {
      if (text.trim()) blocks.push({ type: "text", text });
      text = "";
    };
    const body = (content: string | readonly (TextContent | ImageContent)[]): void => {
      for (const block of typeof content === "string" ? [{ type: "text" as const, text: content }] : content) {
        if (block.type === "text") text += block.text ? `${block.text}\n` : "";
        else {
          flush();
          blocks.push(...userBlocks([block]));
        }
      }
    };
    for (const entry of past) {
      if (entry.kind === "user") {
        text += "<user>\n";
        body(entry.message.content);
        text += "</user>\n";
      } else if (entry.kind === "system") {
        text += `<system-update>\n${renderSystemMessageUpdate(entry.message)}\n</system-update>\n`;
      } else if (entry.kind === "assistant") {
        text += "<assistant>\n";
        for (const block of entry.message.content) {
          if (block.type === "text") text += `${block.text}\n`;
          else if (block.type === "toolCall") {
            text += `<tool-call id=${JSON.stringify(block.id)} name=${JSON.stringify(block.name)}>${JSON.stringify(block.arguments)}</tool-call>\n`;
          }
        }
        text += "</assistant>\n";
      } else {
        const { toolCallId, toolName, isError } = entry.message;
        text += `<tool-result id=${JSON.stringify(toolCallId)} name=${JSON.stringify(toolName)} status="${isError ? "error" : "ok"}">\n`;
        body(entry.message.content);
        text += "</tool-result>\n";
      }
    }
    text += "</conversation-history>\n";
    if (live === entries.length) text += "\nContinue from where the record ends.";
    flush();
  }
  blocks.push(...inputBlocks(entries.slice(live)));
  return blocks.length ? blocks : [{ type: "text", text: EMPTY }];
}
