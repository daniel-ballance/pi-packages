import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { PermissionResult, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { registerClaudeCode, type ClaudeCodeDetails, type ClaudeCodeHost } from "../../extensions/claude-subscription/src/delegate.js";
import { fakeQuery, type FakeClaude, type Script } from "./claude.js";

export const SESSION = "2e59bee6-4a52-4388-aa10-386985110c46";

type Result = AgentToolResult<ClaudeCodeDetails>;
type Tool = ToolDefinition<any, ClaudeCodeDetails>;

/**
 * The frames of a delegated run, in the shapes Claude Code 2.1.296 was observed to send
 * with partial messages on: stream events for each API message, one `assistant` frame per
 * finished content block, a `user` frame per tool result, then the `result`.
 */
export class Run {
  private asked = 0;
  constructor(readonly claude: FakeClaude, readonly session = SESSION) {}

  private emit(message: object): void {
    this.claude.emit({ session_id: this.session, ...message });
  }
  init(model = "claude-haiku-5-5"): void {
    this.emit({ type: "system", subtype: "init", model, cwd: this.claude.options.cwd, tools: this.claude.options.tools, permissionMode: "default" });
  }
  rateLimit(info: SDKRateLimitInfo): void {
    this.emit({ type: "rate_limit_event", rate_limit_info: info });
  }
  says(id: string, text: string): void {
    this.claude.text(id, text, { usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 } });
    this.emit({ type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", content: [{ type: "text", text }] } });
  }
  uses(id: string, call: { id: string; name: string; input: object }): void {
    this.claude.toolUse(id, [call]);
    this.emit({ type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", content: [{ type: "tool_use", ...call }] } });
  }
  returns(toolUseId: string, text: string, isError = false): void {
    this.emit({
      type: "user", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] },
    });
  }
  /** A permission request, made the way the SDK makes one. */
  asks(toolUseID: string, name: string, input: Record<string, unknown>, extra: { decisionReason?: string; defaultToNo?: boolean } = {}): Promise<PermissionResult | null> {
    const { canUseTool } = this.claude.options;
    if (!canUseTool) throw new Error("no canUseTool");
    return canUseTool(name, input, { signal: new AbortController().signal, toolUseID, requestId: `request-${++this.asked}`, ...extra });
  }
  finished(report: string, extra: object = {}): void {
    this.emit({
      type: "result", subtype: "success", is_error: false, result: report, num_turns: 1, stop_reason: "end_turn",
      total_cost_usd: 0.004, usage: {}, modelUsage: {}, permission_denials: [], ...extra,
    });
  }
}

export interface Question {
  title: string;
  options: string[];
}

/** A Pi around the tool: the registration, a caller with a scripted dialog, and what the host heard. */
export function harness(t: TestContext, ...scripts: ((run: Run) => Promise<void>)[]) {
  const { query, spawned } = fakeQuery(...scripts.map((script): Script => claude => script(new Run(claude))));
  // Resolved, because the tool compares real paths and a temporary directory is often a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-code-tool-")));
  const cwd = join(root, "project");
  // Pi's saved trust decisions are read from its agent directory; the user's own is left alone.
  const agentDir = join(root, "agent");
  const earlier = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (earlier === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = earlier;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(cwd, "notes.txt"), "alpha\nbeta\ngamma\n");
  // A project with resources Pi protects: its trust is a decision the user was asked for.
  const protectedSettings = join(cwd, ".pi", "settings.json");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(protectedSettings, "{}");

  const rateLimits: SDKRateLimitInfo[] = [];
  const results: SDKResultMessage[] = [];
  const host: ClaudeCodeHost = {
    loadQuery: async () => query,
    env: { PATH: "/bin", CLAUDE_AGENT_SDK_CLIENT_APP: "pi-claude-subscription/0.0.0-test" },
    onRateLimit: info => rateLimits.push(info),
    onResult: result => results.push(result),
    interruptGraceMs: 30,
  };
  let tool: Tool | undefined;
  registerClaudeCode({ registerTool(definition: Tool) { tool = definition; } } as unknown as ExtensionAPI, host);
  if (!tool) throw new Error("claude_code was not registered");
  const registered = tool;

  const questions: Question[] = [];
  /** How the user answers the next dialogs; an exhausted list dismisses, as Escape does. */
  const answers: (string | RegExp)[] = [];
  const caller = { hasUI: true, trusted: true, piSession: "pi-session-1", projectTrust: true };

  return {
    tool: registered, cwd, spawned, questions, answers, caller, rateLimits, results,
    /** Leave the project with nothing Pi asks about, where Pi reports trust nobody gave. */
    withoutProtectedResources() { rmSync(protectedSettings); },
    /** What `/trust` saves. */
    saveTrust(decision: boolean) { new ProjectTrustStore(agentDir).set(cwd, decision); },
    async run(params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: Result) => void) {
      const updates: Result[] = [];
      const ctx = {
        hasUI: caller.hasUI, cwd,
        ui: {
          async select(title: string, options: string[]) {
            questions.push({ title, options });
            const answer = answers.shift();
            return answer === undefined ? undefined : options.find(option => typeof answer === "string" ? option === answer : answer.test(option));
          },
        },
        sessionManager: { getSessionId: () => caller.piSession },
        ...(caller.projectTrust ? { isProjectTrusted: () => caller.trusted } : {}),
      } as unknown as ExtensionToolContext;
      const result = await registered.execute("call-1", params, signal, partial => {
        updates.push(partial);
        onUpdate?.(partial);
      }, ctx);
      return { result, updates, text: result.content.map(block => block.type === "text" ? block.text : "").join("") };
    },
  };
}
