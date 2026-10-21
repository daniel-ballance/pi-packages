import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  AccountInfo, CanUseTool, Options, PermissionResult, SDKRateLimitInfo, SDKResultMessage, SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { StringEnum, Type, type Static, type Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir, hasTrustRequiringProjectResources, keyHint, ProjectTrustStore, truncateToVisualLines,
  type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Inbox, type AgentQuery, type QueryFunction } from "./sdk.js";

/** What the `claude_code` tool needs from its surroundings; the extension supplies it, tests script it. */
export interface ClaudeCodeHost {
  /** The Agent SDK's `query()`, loaded on first use. */
  loadQuery(): Promise<QueryFunction>;
  /** Environment for the Claude Code process: the Claude login, without per-token API routing. */
  env: Record<string, string | undefined>;
  /** Plan-limit news from a delegated run, for the meter the provider also feeds. */
  onRateLimit?(info: SDKRateLimitInfo): void;
  /**
   * The result that ended a delegated run, for spend totals. Its `usage` covers this run;
   * its `modelUsage` and `total_cost_usd` are running totals of the whole Claude Code
   * session, so a resumed session repeats what earlier runs already reported.
   */
  onResult?(result: SDKResultMessage): void;
  /** How long an interrupted run may take to wind down before it is closed regardless. Default: five seconds. */
  interruptGraceMs?: number;
}

export const TOOL_NAME = "claude_code";

const ACCESS = ["read", "edit", "full"] as const;
type Access = (typeof ACCESS)[number];

const READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const SHELL_TOOLS = ["Bash"];
/**
 * Tools that start work outliving or multiplying the run. The tool list above already
 * leaves them out; naming them here keeps a setting, plugin or skill from bringing one back.
 */
const NEVER_TOOLS = ["Agent", "Task", "Workflow", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"];
/** Tools whose every call is put to the Pi user, whatever Claude Code's own rules would allow. */
const ALWAYS_ASK = new Set([...EDIT_TOOLS, ...SHELL_TOOLS, "WebSearch", "WebFetch"]);

const DEFAULT_MAX_TURNS = 50;
const INTERRUPT_GRACE_MS = 5_000;
/** The card and the session entry keep this many tool lines; the count stays exact. */
const MAX_TOOL_LINES = 200;
/** A report beyond this is cut for the calling model, which can resume the session and ask for the rest. */
const MAX_REPORT_CHARS = 50_000;

const SIGN_IN = "Run `claude auth login`, sign in with your Claude account, then try again.";

const APPENDED_PROMPT = [
  "You were started by Pi, another coding agent, which handed you the task in the user message.",
  "Nobody reads your intermediate messages. Your final message is returned to the calling agent as the result of the task,",
  "so end with a self-contained report: what you found or changed, the files and commands involved, and anything left undone.",
  "You cannot ask questions. Where the task is ambiguous, choose the most reasonable reading and state the assumption in the report.",
  "Edits, shell commands and reads outside the working directory are confirmed by the Pi user. If one is declined, do not retry it; work without it or report what you needed.",
].join(" ");

const TaskParameters = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "The whole task, self-contained: goal, constraints, relevant paths, and what the report should contain. Claude Code sees none of this conversation.",
  }),
  access: Type.Optional(StringEnum(ACCESS, {
    description: "What Claude Code may do: read (read and search files, web lookups), edit (also edit files), full (also run shell commands). Default: read.",
    default: "read",
  })),
  model: Type.Optional(Type.String({ description: 'Claude model id or alias ("haiku", "sonnet", "opus"). Default: Claude Code\'s own default model.' })),
  effort: Type.Optional(StringEnum(["low", "medium", "high", "xhigh", "max"] as const, { description: "Reasoning effort. Default: Claude Code's own." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the task. Default: Pi's working directory." })),
  resume: Type.Optional(Type.String({
    description: "Claude Code session id from the end of an earlier claude_code result. Continues that session with its history; task is the next instruction.",
  })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: `Model round trips before Claude Code is stopped. Default: ${DEFAULT_MAX_TURNS}.` })),
});
type Params = Static<typeof TaskParameters>;

type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** One tool call Claude Code made, as a line of the card. */
export interface ToolLine {
  id: string;
  name: string;
  /** The path, command, pattern or URL the call was about. */
  summary: string;
  status: "running" | "done" | "failed" | "denied";
  /** Why a denied call did not run. */
  note?: string;
}

/** A delegated run as the card and the session entry record it. */
export interface ClaudeCodeDetails {
  status: "running" | "done" | "failed" | "aborted";
  /** Claude Code's id for the session; `resume` takes it. */
  sessionId?: string;
  model?: string;
  access: Access;
  cwd: string;
  /** Whether the project's own Claude Code settings and CLAUDE.md were loaded. */
  projectSettings: boolean;
  turns: number;
  toolCount: number;
  /** The most recent tool calls, oldest first. */
  tools: ToolLine[];
  /** Calls that did not run because the user, or a rule, refused them. */
  denials: { id: string; tool: string; target: string; reason: string }[];
  /** Tokens of every model request in this run. */
  usage: Counts;
  /** The latest text Claude Code wrote, while it is running. */
  text: string;
  error?: string;
}

type Result = AgentToolResult<ClaudeCodeDetails>;
type Caller = Pick<ExtensionContext, "ui" | "hasUI" | "cwd" | "isProjectTrusted" | "sessionManager">;

// Everything Claude Code reports is untrusted text on its way to a terminal or a dialog.
function plain(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "") : "";
}

function inline(value: unknown): string {
  return plain(value).replace(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The path with symlinks resolved as far as it exists, so a link inside a directory cannot stand for a place outside it. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent), basename(path));
  }
}

function inside(dir: string, path: string): boolean {
  const offset = relative(canonical(dir), canonical(path));
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

function shown(path: string, cwd: string): string {
  return inside(cwd, path) ? relative(cwd, path) || "." : path;
}

/** One line for a tool call: the argument a reader would ask about first. */
function summarize(name: string, input: Record<string, unknown>, cwd: string): string {
  const text = (key: string): string | undefined => typeof input[key] === "string" && input[key] ? input[key] : undefined;
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  const where = path === undefined ? "" : shown(resolve(cwd, path), cwd);
  if (name === "Bash") return `$ ${inline(text("command"))}`;
  if (name === "Grep" || name === "Glob") return [inline(text("pattern")), where && `in ${where}`].filter(Boolean).join(" ");
  if (name === "WebFetch") return inline(text("url"));
  if (name === "WebSearch") return inline(text("query"));
  if (name === "Skill") return inline(text("skill"));
  return where || clip(inline(JSON.stringify(input)), 120);
}

/** A request for approval, in the terms the user is asked about and may answer "always" to. */
interface Ask {
  tool: string;
  /** The access level a call like this belongs to. */
  needs: Access;
  /** What an "always" answer is remembered under. */
  kind: string;
  /** The command, path, URL or query in question. */
  target: string;
  /** What the call would do there, where a path or a command alone does not say. */
  detail?: string;
  path?: string;
  /** What "always" would cover; absent when nothing narrower than the single call can be named. */
  always?: { dir?: string; label: string };
}

function classify(tool: string, input: Record<string, unknown>, cwd: string): Ask {
  const text = (key: string): string | undefined => typeof input[key] === "string" && input[key] ? input[key] : undefined;
  const fallback = clip(inline(JSON.stringify(input)), 300);
  if (tool === "Read" || tool === "Glob" || tool === "Grep") {
    const path = resolve(cwd, text("file_path") ?? text("path") ?? ".");
    const dir = tool === "Read" ? dirname(path) : path;
    return { tool, needs: "read", kind: "read", target: path, path, always: { dir, label: `Always allow reading under ${dir}` } };
  }
  if (EDIT_TOOLS.includes(tool)) {
    const file = text("file_path") ?? text("notebook_path");
    if (file === undefined) return { tool, needs: "edit", kind: "edit", target: fallback };
    const path = resolve(cwd, file);
    const dir = inside(cwd, path) ? cwd : dirname(path);
    const before = text("old_string"), after = text("new_string"), written = text("content");
    const detail = before !== undefined || after !== undefined ? `- ${clip(inline(before), 160)}\n+ ${clip(inline(after), 160)}`
      : written !== undefined ? `writes ${written.split("\n").length} line${written.includes("\n") ? "s" : ""}` : undefined;
    return { tool, needs: "edit", kind: "edit", target: path, detail, path, always: { dir, label: `Always allow edits under ${dir}` } };
  }
  // A prefix of a command says little about the whole of it, so "always" for the shell is all or nothing.
  if (tool === "Bash") {
    return { tool, needs: "full", kind: "shell", target: text("command") ?? fallback, detail: text("description"), always: { label: "Always allow shell commands" } };
  }
  if (tool === "WebSearch") return { tool, needs: "read", kind: "search", target: text("query") ?? fallback, always: { label: "Always allow web searches" } };
  if (tool === "WebFetch") {
    const url = text("url") ?? fallback;
    let host: string | undefined;
    try {
      host = new URL(url).hostname;
    } catch {}
    return { tool, needs: "read", kind: `fetch ${host}`, target: url, always: host ? { label: `Always allow fetching from ${host}` } : undefined };
  }
  if (tool === "Skill") {
    const skill = text("skill") ?? fallback;
    return { tool, needs: "read", kind: `skill ${skill}`, target: skill, always: { label: `Always allow the ${clip(inline(skill), 60)} skill` } };
  }
  return { tool, needs: "read", kind: `tool ${tool}`, target: fallback, always: { label: `Always allow ${tool}` } };
}

const REFUSED_BY_RULE = "refused by Claude Code's own rules";
const ALLOW_ONCE = "Allow once";
const DENY = "Deny";

/**
 * What the user has answered "always" to in one Pi session. It lives here and not in
 * Claude Code because every delegated run is a new process, and because the rules that
 * force the question (see `startOptions`) outrank any allow rule Claude Code could be given.
 */
class Approvals {
  private readonly grants: { kind: string; dir?: string }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private covers(ask: Ask): boolean {
    return this.grants.some(grant => grant.kind === ask.kind
      && (grant.dir === undefined || (ask.path !== undefined && inside(grant.dir, ask.path))));
  }

  /**
   * Put one request to the user. Claude Code may ask about several calls at once; they are
   * shown one at a time, so an "always" answer settles the ones waiting behind it.
   */
  decide(ask: Ask, caller: Caller, title: string, cautious: boolean, signal: AbortSignal): Promise<"allow" | "deny" | "nobody"> {
    if (this.covers(ask)) return Promise.resolve("allow");
    if (!caller.hasUI) return Promise.resolve("nobody");
    const answer = this.queue.then(async () => {
      if (this.covers(ask)) return "allow";
      if (signal.aborted) return "deny";
      const always = ask.always ? `${ask.always.label} for this session` : undefined;
      const allow = always ? [ALLOW_ONCE, always] : [ALLOW_ONCE];
      // Claude Code marks some requests as ones a stray Enter must not approve.
      const choice = await caller.ui.select(title, cautious ? [DENY, ...allow] : [...allow, DENY], { signal });
      if (choice === always && ask.always) this.grants.push({ kind: ask.kind, dir: ask.always.dir });
      return choice === ALLOW_ONCE || (always !== undefined && choice === always) ? "allow" : "deny";
    });
    this.queue = answer.catch(() => {});
    return answer.catch(() => "deny" as const);
  }
}

/** Token counts of a run: each model request reports its own, and later reports of a request replace earlier ones. */
class Tokens {
  private earlier: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private current: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  begin(reported: Reported): void {
    this.earlier = this.total;
    this.current = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.note(reported);
  }

  note(reported: Reported): void {
    if (reported.input_tokens != null) this.current.input = reported.input_tokens;
    if (reported.output_tokens != null) this.current.output = reported.output_tokens;
    if (reported.cache_read_input_tokens != null) this.current.cacheRead = reported.cache_read_input_tokens;
    if (reported.cache_creation_input_tokens != null) this.current.cacheWrite = reported.cache_creation_input_tokens;
  }

  get total(): Counts {
    const { earlier, current } = this;
    return {
      input: earlier.input + current.input, output: earlier.output + current.output,
      cacheRead: earlier.cacheRead + current.cacheRead, cacheWrite: earlier.cacheWrite + current.cacheWrite,
    };
  }
}

interface Reported {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Pi adds a tool's `usage` to the session totals. Nothing is billed per token on a subscription, so the cost stays zero. */
function piUsage(counts: Counts): Usage {
  return {
    ...counts, totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function describeAccount(account: AccountInfo): string {
  if (account.apiProvider && account.apiProvider !== "firstParty") return ` (it is using ${account.apiProvider})`;
  if (account.apiKeySource && account.apiKeySource !== "none") return ` (it is using an API key from ${account.apiKeySource})`;
  return "";
}

/**
 * The options one delegated run starts Claude Code with.
 *
 * Permissions. Claude Code runs its own tools here, so none of this passes through Pi's
 * `tool_call` event or the permission extensions that listen to it; Pi gates the delegation
 * as a whole, and the four options below gate what happens inside it.
 *
 * - `permissionMode: "default"`, stated explicitly. Left out, Claude Code takes the mode from
 *   the user's settings or starts in `auto`, where a classifier approves calls instead of the
 *   user. `acceptEdits` and `bypassPermissions` would skip the question this tool exists to ask.
 * - `permissionPrompts: "host"` with `canUseTool`: whatever Claude Code would prompt for
 *   in its own terminal arrives at `canUseTool`, which asks the Pi user through `ctx.ui`.
 *   Without a UI the same callback refuses, with a reason written for the model. (`"none"`
 *   would refuse too, but in Claude Code's words and without a record on the card.)
 * - No `allowedTools`. An entry there approves a tool before `canUseTool` is consulted; the
 *   SDK warns (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) that a bare entry shadows the callback
 *   entirely. What is offered is narrowed with `tools` instead, which removes a tool from
 *   the model's view, and `disallowedTools` names the ones that must never come back.
 * - `settings.permissions.ask` for every edit, shell and web tool. In default mode Claude Code
 *   decides alone that a shell command is read-only (`ls` ran unprompted in a probe), and
 *   allow rules in the user's or the project's Claude Code settings approve calls silently.
 *   A whole-tool ask rule outranks both, so each such call reaches `canUseTool` (probed: with
 *   the rule, `ls` was asked about even beside a bare `allowedTools: ["Bash"]`). Reads are
 *   left to Claude Code's own check: inside the working directory they run, outside it asks.
 *
 * "Always" answers are therefore kept on this side (`Approvals`), not handed back as
 * `updatedPermissions`: an allow rule cannot override the ask rule, and it would die with
 * the process anyway.
 */
function startOptions(
  params: Params, access: Access, cwd: string, projectSettings: boolean, host: ClaudeCodeHost,
  canUseTool: CanUseTool, onStderr: (data: string) => void,
): Options {
  const tools = [...READ_TOOLS, ...(access === "read" ? [] : EDIT_TOOLS), ...(access === "full" ? SHELL_TOOLS : [])];
  const settingSources: SettingSource[] = projectSettings ? ["user", "project"] : ["user"];
  return {
    cwd,
    // A background shell would outlive the result that reports on it.
    env: { ...host.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    // A provider prefix is Pi's way of naming a model, not Claude Code's.
    model: params.model?.slice(params.model.lastIndexOf("/") + 1) || undefined,
    effort: params.effort,
    systemPrompt: { type: "preset", preset: "claude_code", append: APPENDED_PROMPT },
    tools,
    disallowedTools: NEVER_TOOLS,
    // Pi has its own MCP client; the user's Claude Code servers and claude.ai connectors stay out of a delegated run.
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: "default",
    permissionPrompts: "host",
    canUseTool,
    settings: { permissions: { ask: tools.filter(tool => ALWAYS_ASK.has(tool)) } },
    // The user's CLAUDE.md, skills and settings always; the project's only where the user trusts the project.
    settingSources,
    // Unlike the provider's sessions, a delegated one is kept, so a later call can resume it by id.
    persistSession: true,
    ...(params.resume ? { resume: params.resume } : { sessionId: randomUUID(), title: `Pi: ${clip(inline(params.task), 60)}` }),
    maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
    // Stream events carry the token counts of each request, including a run that is cut short.
    includePartialMessages: true,
    stderr: onStderr,
  };
}

/**
 * Whether someone has decided to trust the project Pi runs in. Claude Code's project settings
 * can run hooks and set its environment, and a Claude Code started this way does not ask about
 * them as its terminal would, so they load only on a decision.
 *
 * `isProjectTrusted()` alone is not one: Pi answers true for a folder that holds nothing Pi
 * protects, without anyone having been asked. A decision exists when Pi had resources to ask
 * about, or when the user saved one with `/trust`. A Pi without project trust cannot say, and
 * then only the user's own settings load.
 */
function vouchedFor(caller: Caller): boolean {
  if (typeof caller.isProjectTrusted !== "function" || !caller.isProjectTrusted()) return false;
  try {
    return hasTrustRequiringProjectResources(caller.cwd) || new ProjectTrustStore(getAgentDir()).get(caller.cwd) === true;
  } catch {
    return false;
  }
}

function snapshot(details: ClaudeCodeDetails): ClaudeCodeDetails {
  return { ...details, tools: details.tools.map(line => ({ ...line })), denials: details.denials.map(denial => ({ ...denial })), usage: { ...details.usage } };
}

/** The line that ends every result: where the session id comes from, for the model and for a reader of print output. */
function trailer(details: ClaudeCodeDetails): string {
  const parts = [
    details.sessionId ? `session ${details.sessionId} (pass as "resume" to continue it)` : "no session",
    `${details.turns} turn${details.turns === 1 ? "" : "s"}`,
    `${details.toolCount} tool call${details.toolCount === 1 ? "" : "s"}`,
  ];
  const denied = details.denials.map(denial => `${denial.tool} ${clip(inline(denial.target), 80)} (${denial.reason})`);
  return `[claude_code: ${parts.join(" · ")}]${denied.length ? `\n[not run: ${denied.join("; ")}]` : ""}`;
}

async function delegate(
  host: ClaudeCodeHost, approvals: Approvals, params: Params, signal: AbortSignal | undefined,
  onUpdate: ((partial: Result) => void) | undefined, caller: Caller,
): Promise<Result> {
  const access: Access = params.access ?? "read";
  const cwd = resolve(caller.cwd, params.cwd ?? ".");
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  if (params.resume !== undefined && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.resume)) {
    throw new Error("resume must be a Claude Code session id, as printed at the end of an earlier claude_code result.");
  }
  // Pi's trust is about the project it was started in. A directory outside it has not been vouched for.
  const projectSettings = vouchedFor(caller) && inside(caller.cwd, cwd);

  const details: ClaudeCodeDetails = {
    status: "running", access, cwd, projectSettings, turns: 0, toolCount: 0, tools: [], denials: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, text: "",
  };
  const tokens = new Tokens();
  /** Tool call id -> why it did not run. */
  const refused = new Map<string, string>();
  let stderr = "";
  let failure: string | undefined;

  const finish = (status: ClaudeCodeDetails["status"], text: string): Result => {
    details.status = status;
    details.usage = tokens.total;
    if (status !== "done") details.error = text;
    // The report is the result's content. The session entry does not need it twice.
    details.text = "";
    for (const line of details.tools) if (line.status === "running") line.status = status === "done" ? "done" : "failed";
    const body = text.length > MAX_REPORT_CHARS
      ? `${text.slice(0, MAX_REPORT_CHARS)}\n[report cut at ${MAX_REPORT_CHARS} characters; resume the session and ask for the rest]` : text;
    return {
      content: [{ type: "text", text: `${body}\n\n${trailer(details)}` }],
      details: snapshot(details), usage: piUsage(details.usage), ...(status === "done" ? {} : { isError: true }),
    };
  };
  const update = (): void => {
    details.usage = tokens.total;
    onUpdate?.({ content: [{ type: "text", text: details.text || "Claude Code is working…" }], details: snapshot(details) });
  };
  const notRun = (id: string, tool: string, target: string, reason: string): void => {
    if (refused.has(id)) return;
    refused.set(id, reason);
    details.denials.push({ id, tool, target: clip(plain(target), 300), reason });
    const line = details.tools.find(candidate => candidate.id === id);
    if (line) Object.assign(line, { status: "denied", note: reason });
    update();
  };
  const deny = (id: string, ask: Ask, reason: string, message: string): PermissionResult => {
    notRun(id, ask.tool, ask.target, reason);
    return { behavior: "deny", message };
  };
  const stopped = (): Result => finish("aborted",
    `Aborted. Claude Code was stopped${details.sessionId ? "; what it did so far is kept in the session" : ""}.${details.text ? `\n\nIts last message:\n${details.text}` : ""}`);

  let query: AgentQuery | undefined;
  let aborted = signal?.aborted === true;
  let grace: NodeJS.Timeout | undefined;
  let giveUp!: (error: Error) => void;
  const gaveUp = new Promise<never>((_resolve, reject) => {
    giveUp = reject;
  });
  gaveUp.catch(() => {});
  const onAbort = (): void => {
    aborted = true;
    if (!query) return;
    // An interrupt lets Claude Code stop its tool and report what the turn used. It is closed afterwards either way.
    query.interrupt().catch(() => {});
    grace ??= setTimeout(() => giveUp(new Error("aborted")), host.interruptGraceMs ?? INTERRUPT_GRACE_MS);
  };

  const canUseTool: CanUseTool = async (tool, input, request) => {
    const ask = classify(tool, input, cwd);
    // The tool list already matches `access`. This holds the line if a skill or plugin offers a tool of its own.
    if (ACCESS.indexOf(ask.needs) > ACCESS.indexOf(access)) {
      return deny(request.toolUseID, ask, `needs ${ask.needs} access`,
        `This task was delegated with ${access} access, which does not include ${tool}. Do not retry; report what you would have done.`);
    }
    const title = [
      `Claude Code asks to use ${tool}:`, "", `  ${clip(plain(ask.target), 600)}`,
      ...plain(ask.detail).split("\n").filter(Boolean).map(line => `  ${clip(line, 200)}`), "",
      `${request.decisionReason ? `${inline(request.decisionReason)}. ` : ""}Working directory: ${cwd}`,
    ].join("\n");
    const dismissed = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
    const answer = await approvals.decide(
      request.suppressAlwaysAllowRule ? { ...ask, always: undefined } : ask, caller, title, request.defaultToNo === true, dismissed);
    if (answer === "allow") return { behavior: "allow", updatedInput: input };
    if (answer === "nobody") {
      return deny(request.toolUseID, ask, "no UI to approve it",
        `${tool} needs the user's approval, and Pi is running without an interactive UI (print or JSON mode), so nobody can give it. The same goes for every other edit, shell command and web lookup in this run. Do not retry or try another tool; finish with what you can do without it and say what was left undone.`);
    }
    return deny(request.toolUseID, ask, "declined by the user",
      `The user declined this ${tool} call. Do not retry it or work around it; continue without it, or report what you needed and why.`);
  };

  const inbox = new Inbox();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (aborted) return finish("aborted", "Aborted before Claude Code started.");
    const load = await host.loadQuery();
    if (aborted) return finish("aborted", "Aborted before Claude Code started.");
    query = load({
      prompt: inbox,
      options: startOptions(params, access, cwd, projectSettings, host, canUseTool, data => {
        stderr = (stderr + data).slice(-2_000);
      }),
    });

    // The login is Claude Code's own. Anything but a subscription would bill per token.
    const { account } = await Promise.race([query.initializationResult(), gaveUp]);
    if (!account.subscriptionType) {
      return finish("failed", `Claude Code is not signed in with a Claude subscription${describeAccount(account)}. ${SIGN_IN}`);
    }
    inbox.push({ type: "user", message: { role: "user", content: params.task }, parent_tool_use_id: null, uuid: randomUUID() });

    const messages = query[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([messages.next(), gaveUp]);
      if (next.done) {
        if (aborted) break;
        return finish("failed", `Claude Code exited before finishing the task.${stderr.trim() ? ` ${plain(stderr).trim()}` : ""}${details.sessionId ? " The session can be resumed." : ""}`);
      }
      const message = next.value;
      // A resumed session may answer under a new id; the latest one is the one to resume.
      if ("session_id" in message && typeof message.session_id === "string" && message.session_id) details.sessionId = message.session_id;
      if (message.type === "system" && message.subtype === "init") {
        details.model = message.model;
        update();
      } else if (message.type === "system" && message.subtype === "permission_denied") {
        // Refused by Claude Code itself, by a deny rule in the user's settings for instance.
        notRun(message.tool_use_id, message.tool_name, details.tools.find(line => line.id === message.tool_use_id)?.summary ?? "", REFUSED_BY_RULE);
      } else if (message.type === "rate_limit_event") {
        host.onRateLimit?.(message.rate_limit_info);
      } else if (message.type === "stream_event") {
        if (message.parent_tool_use_id !== null) continue;
        if (message.event.type === "message_start") {
          details.turns++;
          tokens.begin(message.event.message.usage);
        } else if (message.event.type === "message_delta") tokens.note(message.event.usage);
      } else if (message.type === "assistant") {
        if (message.parent_tool_use_id !== null) continue;
        if (message.error) {
          // Claude Code reports a failed request as a synthetic message; its text is the error.
          failure = message.message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") || `Claude request failed: ${message.error}`;
          if (message.error === "authentication_failed") failure += ` ${SIGN_IN}`;
          if (message.error === "rate_limit") failure += " The Claude plan limit was reached: wait for it to reset (/claude-subscription shows when) or carry on without claude_code.";
          continue;
        }
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) details.text = plain(block.text).trim();
          else if (block.type === "tool_use") {
            details.toolCount++;
            // A refusal can arrive before the frame that shows the call.
            const note = refused.get(block.id);
            details.tools.push({
              id: block.id, name: block.name, ...(note === undefined ? { status: "running" } : { status: "denied", note }),
              summary: clip(summarize(block.name, typeof block.input === "object" && block.input !== null ? block.input as Record<string, unknown> : {}, cwd), 200),
            });
            if (details.tools.length > MAX_TOOL_LINES) details.tools.shift();
          }
        }
        update();
      } else if (message.type === "user") {
        if (message.parent_tool_use_id !== null || !Array.isArray(message.message.content)) continue;
        for (const block of message.message.content) {
          if (block.type !== "tool_result") continue;
          const line = details.tools.find(candidate => candidate.id === block.tool_use_id);
          if (line?.status === "running") line.status = block.is_error ? "failed" : "done";
        }
        update();
      } else if (message.type === "result") {
        host.onResult?.(message);
        details.turns = Math.max(details.turns, message.num_turns);
        // The list is the authoritative record of refusals; an older Claude Code may not send it.
        for (const denial of message.permission_denials ?? []) {
          notRun(denial.tool_use_id, denial.tool_name, classify(denial.tool_name, denial.tool_input, cwd).target, REFUSED_BY_RULE);
        }
        if (aborted) break;
        if (message.subtype === "success" && !message.is_error) return finish("done", plain(message.result).trim() || details.text || "(Claude Code finished without a report.)");
        if (message.subtype === "error_max_turns") {
          return finish("failed", `Claude Code stopped after ${message.num_turns} turns without finishing. Resume the session to let it continue, or raise maxTurns.${details.text ? `\n\nIts last message:\n${details.text}` : ""}`);
        }
        return finish("failed", failure || (message.subtype === "success" ? plain(message.result) : plain(message.errors.join("; ")))
          || `Claude Code reported an error (${message.subtype}).`);
      }
    }
    return stopped();
  } catch (error) {
    if (aborted) return stopped();
    return finish("failed", `Claude Code could not run the task: ${error instanceof Error ? error.message : String(error)}${stderr.trim() ? ` ${plain(stderr).trim()}` : ""}`);
  } finally {
    clearTimeout(grace);
    signal?.removeEventListener("abort", onAbort);
    // Nothing is left behind: the input ends and the process is terminated, finished or not.
    inbox.end();
    query?.close();
  }
}

// --- The card ---

type Color = Parameters<Theme["fg"]>[0];

// Pi's own Text wrapping, reached through its public export so the card needs no package of its own.
function wrap(text: string, width: number, lines = Infinity): string[] {
  return truncateToVisualLines(text, lines, width, 0, "start").visualLines;
}

/** Stateless layout: theme and width are read again on every render. */
function component(layout: (width: number) => string[]) {
  return { render: (width: number) => width < 1 ? [] : layout(width), invalidate() {} };
}

function tokenText(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

const STATUS: Record<ClaudeCodeDetails["status"], [icon: string, word: string, color: Color]> = {
  running: ["●", "working", "accent"],
  done: ["✓", "done", "success"],
  failed: ["✗", "failed", "error"],
  aborted: ["○", "aborted", "warning"],
};

function headline(details: ClaudeCodeDetails, theme: Theme): string {
  const [icon, word, color] = STATUS[details.status];
  const { usage } = details;
  const sent = usage.input + usage.cacheRead + usage.cacheWrite;
  const facts = [
    `${details.turns} turn${details.turns === 1 ? "" : "s"}`,
    `${details.toolCount} tool call${details.toolCount === 1 ? "" : "s"}`,
    sent || usage.output ? `↑${tokenText(sent)} ↓${tokenText(usage.output)}` : "",
    details.denials.length ? `${details.denials.length} not run` : "",
  ].filter(Boolean);
  return theme.fg(color, `${icon} ${word}`) + theme.fg("muted", ` · ${facts.join(" · ")}`);
}

function toolText(line: ToolLine, theme: Theme): string {
  const mark = line.status === "failed" ? theme.fg("error", "✗ ") : line.status === "denied" ? theme.fg("warning", "⊘ ") : theme.fg("muted", "→ ");
  return mark + theme.fg(line.status === "running" ? "accent" : "toolOutput", line.name) + theme.fg("dim", ` ${line.summary}`)
    + (line.status === "denied" ? theme.fg("warning", ` (${line.note ?? "not run"})`) : "");
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

function isDetails(value: unknown): value is ClaudeCodeDetails {
  return typeof value === "object" && value !== null && "status" in value && "tools" in value && Array.isArray(value.tools) && "usage" in value;
}

/** The key that expands a tool row, as the user has bound it. Outside the interactive UI there is no binding to name. */
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "for the tool list and the full report");
  } catch {
    return "expand for the tool list and the full report";
  }
}

const COLLAPSED_TOOLS = 3;
const COLLAPSED_TEXT_LINES = 4;

const renderCall: NonNullable<ToolDefinition<typeof TaskParameters, ClaudeCodeDetails>["renderCall"]> = (args, theme, context) => component(width => {
  const facts = [args.access ?? "read", args.model, args.effort, args.resume ? `resumes ${args.resume.slice(0, 8)}` : "", args.cwd].filter(Boolean);
  const title = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("accent", facts.join(" · "));
  return [...wrap(title, width, 1), ...wrap(theme.fg("dim", plain(args.task)), width, context.expanded ? Infinity : 2)];
});

const renderResult: NonNullable<ToolDefinition<typeof TaskParameters, ClaudeCodeDetails>["renderResult"]> = (result, { expanded, isPartial }, theme) => component(width => {
  const details = result.details;
  const text = plain(resultText(result));
  // A result without the run's record: a blocked call, or an entry written by another version.
  if (!isDetails(details)) return wrap(theme.fg("toolOutput", text), width, expanded ? Infinity : COLLAPSED_TEXT_LINES);
  const lines = wrap(headline(details, theme), width, 1);
  if (expanded) {
    const facts = [details.sessionId ? `session ${details.sessionId}` : "", details.model, `${details.access} access`, details.cwd,
      details.projectSettings ? "user and project settings" : "user settings"].filter(Boolean);
    lines.push(...wrap(theme.fg("dim", facts.join(" · ")), width));
    if (details.toolCount > details.tools.length) lines.push(...wrap(theme.fg("muted", `… ${details.toolCount - details.tools.length} earlier tool calls`), width, 1));
    for (const line of details.tools) lines.push(...wrap(toolText(line, theme), width));
    // A refusal whose call is not among the lines above still belongs on the card.
    for (const denial of details.denials) {
      if (details.tools.some(line => line.id === denial.id)) continue;
      lines.push(...wrap(theme.fg("warning", `⊘ ${denial.tool}`) + theme.fg("dim", ` ${inline(denial.target)}`) + theme.fg("warning", ` (${denial.reason})`), width));
    }
    lines.push("", ...wrap(theme.fg(details.status === "done" || isPartial ? "toolOutput" : "error", isPartial ? details.text : text), width));
    return lines;
  }
  const earlier = details.toolCount - Math.min(details.tools.length, COLLAPSED_TOOLS);
  if (earlier > 0) lines.push(...wrap(theme.fg("muted", `… ${earlier} earlier tool call${earlier === 1 ? "" : "s"}`), width, 1));
  for (const line of details.tools.slice(-COLLAPSED_TOOLS)) lines.push(...wrap(toolText(line, theme), width, 1));
  const body = isPartial ? details.text : details.status === "done" ? text : details.error ?? text;
  const preview = truncateToVisualLines(theme.fg(details.status === "done" || isPartial ? "toolOutput" : "error", body), COLLAPSED_TEXT_LINES, width, 0, "start");
  lines.push(...preview.visualLines);
  if (!isPartial) lines.push(...wrap(theme.fg("dim", `${preview.skippedCount > 0 ? "… " : ""}(${expandHint()})`), width, 1));
  return lines;
});

/** Register `claude_code`: a task handed to Claude Code, which works on it with its own tools and loop and reports back. */
export function registerClaudeCode(pi: ExtensionAPI, host: ClaudeCodeHost): void {
  // "Always" answers last as long as the Pi session they were given in.
  const sessions = new Map<string, Approvals>();
  const approvalsFor = (caller: Caller): Approvals => {
    let key = "";
    try {
      key = caller.sessionManager.getSessionId();
    } catch {}
    let approvals = sessions.get(key);
    if (!approvals) sessions.set(key, approvals = new Approvals());
    return approvals;
  };

  pi.registerTool<typeof TaskParameters, ClaudeCodeDetails>({
    name: TOOL_NAME,
    label: "Claude Code",
    description: [
      "Hand a whole task to Claude Code, which works on it in a session of its own, with its own tools, context window and loop, and returns a report.",
      "It runs on the user's Claude subscription whichever model Pi is using.",
      "The result is Claude Code's final report, not a transcript of what it did: say in the task what you need back.",
      "access sets what it may do: read (the default: read and search files, look things up on the web), edit (also edit files), full (also run shell commands).",
      "The user is asked to confirm edits, shell commands, web lookups and reads outside the working directory; without an interactive UI those are refused.",
      "Every result ends with a line naming the Claude Code session id of that run. Pass that id as resume to continue the same session, with its history, on a follow-up task.",
    ].join(" "),
    promptSnippet: "Delegate a self-contained task to Claude Code on the user's Claude plan; returns its final report and a session id to resume",
    promptGuidelines: [
      "Use claude_code for self-contained work that would otherwise fill this conversation with file contents or tool output: surveying unfamiliar code, a multi-file change with a clear specification, an independent second look. Do quick, small steps yourself.",
      "claude_code starts with none of this conversation. Put the goal, the constraints, the relevant paths and what the report must contain in task, and ask for the least access that does the job.",
      "claude_code returns a report, not a transcript. Check the claims that matter (read the diff, run the tests) before relying on them.",
      "To continue delegated work, pass the session id from the end of the earlier claude_code result as resume instead of explaining the task again.",
    ],
    parameters: TaskParameters,
    // It can edit files and run commands, and reaches the web; a permission extension may want to confirm the delegation itself.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    execute: (_toolCallId, params, signal, onUpdate, ctx) => delegate(host, approvalsFor(ctx), params, signal, onUpdate, ctx),
    renderCall,
    renderResult,
  });
}
