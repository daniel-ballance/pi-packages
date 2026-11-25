import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { SERVER_NAME } from "./tools.js";

export type Status = "pending" | "in_progress" | "completed" | "failed";
export type Diff = { path: string; oldText: string; newText: string };
export type ToolFrame = RequestPermissionRequest["toolCall"];
export type Permission = { options: RequestPermissionRequest["options"]; answer(response: RequestPermissionResponse): void };
export interface ObservedCall {
  id: string;
  title: string;
  kind: string;
  input?: unknown;
  status: Status;
  pendingPermission?: Permission;
  output?: string;
  diff: Diff[];
}

export type Update = { kind: "text" | "thinking"; text: string }
  | { kind: "start" | "change"; frame: ToolFrame } | { kind: "window"; size: number };
export function mapUpdate(update: SessionUpdate): Update | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": case "agent_thought_chunk":
      if (update.content.type === "text") return { kind: update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", text: update.content.text };
      break;
    case "tool_call": case "tool_call_update":
      return { kind: update.sessionUpdate === "tool_call" ? "start" : "change", frame: update };
    case "usage_update":
      if (Number.isFinite(update.size) && update.size > 0) return { kind: "window", size: update.size };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function piTool(frame: ToolFrame): string | undefined {
  const input = asRecord(frame.rawInput);
  if (typeof input?.CommandLine === "string") return;
  if (input?.ServerName === SERVER_NAME && typeof input.ToolName === "string") {
    const title = frame.title?.trim().replace(/\?$/, "");
    if (frame.name === "call_mcp_tool" || title === `MCP Tool ${input.ToolName}`) return input.ToolName;
  }
  const prefix = `mcp_${SERVER_NAME}_`;
  if (frame.name?.startsWith(prefix)) return frame.name.slice(prefix.length);
  const titleName = /^(?:Run(?:ning)? )?([\w.-]+)\??$/.exec(frame.title?.trim() ?? "")?.[1];
  if (titleName?.startsWith(prefix) && titleName.length > prefix.length) return titleName.slice(prefix.length);
}

const TITLES: Record<string, (input: Record<string, unknown> | undefined) => unknown> = {
  execute: input => input?.CommandLine, edit: input => input?.TargetFile ?? input?.file_path,
  read: input => input?.TargetFile ?? input?.file_path,
};
const PREFIX: Record<string, string> = { execute: "Run command: ", edit: "Edit ", read: "Read " };

export function mergeCall(call: ObservedCall, frame: ToolFrame): void {
  call.kind = call.kind === "question" ? call.kind : frame.kind ?? call.kind;
  call.input = frame.rawInput ?? call.input;
  if (frame.title) {
    const argument = TITLES[call.kind]?.(asRecord(call.input));
    call.title = typeof argument === "string" ? PREFIX[call.kind] + argument : frame.title;
  }
  call.status = frame.status ?? call.status;
  const content = Array.isArray(frame.content) ? frame.content : [];
  const text = content.flatMap(block => block?.type === "content" && block.content?.type === "text" ? [block.content.text] : []);
  if (text?.length) call.output = text.join("\n");
  else if (frame.rawOutput !== undefined && frame.rawOutput !== null) {
    const raw = asRecord(frame.rawOutput);
    call.output = typeof frame.rawOutput === "string" ? frame.rawOutput
      : typeof raw?.combinedOutput === "string" ? raw.combinedOutput
      : typeof raw?.formatted_output === "string" ? raw.formatted_output : JSON.stringify(frame.rawOutput);
  }
  const diff = content.flatMap(block => block?.type === "diff" ? [{ path: block.path, oldText: block.oldText ?? "", newText: block.newText }] : []);
  if (diff?.length) call.diff = diff;
}

export function terminal(call: ObservedCall): boolean {
  return call.status === "completed" || call.status === "failed";
}

export function selection(id?: string): RequestPermissionResponse {
  return { outcome: id ? { outcome: "selected", optionId: id } : { outcome: "cancelled" } };
}

export function answerPermission(options: Permission["options"], allow: boolean): RequestPermissionResponse {
  return selection(options.find(option => option.kind === (allow ? "allow_once" : "reject_once"))?.optionId);
}

export function cancelQuestion(): RequestPermissionResponse {
  return selection();
}

export function questionChoices(options: Permission["options"]): string[] {
  const labels = options.map(option => option.name.trim() || option.optionId);
  return new Set(labels).size === labels.length ? labels : labels.map((label, index) => `${index + 1}. ${label}`);
}
