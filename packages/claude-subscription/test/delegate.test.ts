import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { harness, SESSION, type Run } from "./support/delegate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A run that does nothing but report. */
const reports = (report: string) => async (run: Run): Promise<void> => {
  await run.claude.user();
  run.init();
  run.says("msg_1", report);
  run.finished(report);
};

test("each access level starts Claude Code with its own tools for that level and no more", async t => {
  const h = harness(t, reports("ok"), reports("ok"), reports("ok"));
  await h.run({ task: "Survey the notes." });
  await h.run({ task: "Fix the notes.", access: "edit", model: "claude-subscription/claude-haiku-5-5", effort: "low", maxTurns: 7 });
  await h.run({ task: "Run the tests.", access: "full", cwd: "src" });
  const [read, edit, full] = h.spawned.map(claude => claude.options);

  assert.deepEqual(read.tools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"]);
  assert.deepEqual(edit.tools, [...read.tools as string[], "Edit", "Write", "NotebookEdit"]);
  assert.deepEqual(full.tools, [...edit.tools as string[], "Bash"]);
  // Every call that changes something or leaves the machine is put to the user, whatever Claude Code's own rules say.
  assert.deepEqual(read.settings, { permissions: { ask: ["WebSearch", "WebFetch"] } });
  assert.deepEqual(edit.settings, { permissions: { ask: ["WebSearch", "WebFetch", "Edit", "Write", "NotebookEdit"] } });
  assert.deepEqual(full.settings, { permissions: { ask: ["WebSearch", "WebFetch", "Edit", "Write", "NotebookEdit", "Bash"] } });

  for (const options of [read, edit, full]) {
    for (const never of ["Agent", "Workflow", "CronCreate", "ScheduleWakeup"]) {
      assert.ok(!(options.tools as string[]).includes(never) && options.disallowedTools?.includes(never), never);
    }
    assert.equal(options.permissionMode, "default", "never Claude Code's auto mode or the user's configured mode");
    assert.equal(options.permissionPrompts, "host");
    assert.equal(typeof options.canUseTool, "function");
    assert.equal(options.allowedTools, undefined, "an allowed tool would be approved before the user is asked");
    assert.equal(options.persistSession, true, "a delegated session can be resumed");
    assert.match(options.sessionId ?? "", UUID);
    assert.equal(options.resume, undefined);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, "pi-claude-subscription/0.0.0-test", "the host's environment");
    const prompt = options.systemPrompt;
    assert.ok(typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset" && prompt.preset === "claude_code");
    assert.match(prompt.append ?? "", /started by Pi/);
    assert.match(prompt.append ?? "", /final message is returned to the calling agent/);
  }
  assert.equal(read.cwd, h.cwd);
  assert.equal(full.cwd, join(h.cwd, "src"), "a relative cwd is taken from Pi's");
  assert.equal(read.model, undefined, "Claude Code's own default model");
  assert.equal(read.maxTurns, 50);
  assert.equal(edit.model, "claude-haiku-5-5", "Pi's provider prefix is not part of a Claude Code model id");
  assert.equal(edit.effort, "low");
  assert.equal(edit.maxTurns, 7);
  assert.equal(read.title, "Pi: Survey the notes.");
  assert.deepEqual(h.spawned.map(claude => claude.received.map(message => message.message.content)), [["Survey the notes."], ["Fix the notes."], ["Run the tests."]]);
});

test("the project's Claude Code settings load only when someone decided to trust the project and the task stays inside it", async t => {
  const h = harness(t, ...Array.from({ length: 6 }, () => reports("ok")));
  const sources = async (params: Record<string, unknown> = {}) => {
    const { result } = await h.run({ task: "Look.", ...params });
    return { sources: h.spawned.at(-1)?.options.settingSources, projectSettings: result.details.projectSettings };
  };
  const both = { sources: ["user", "project"], projectSettings: true };
  const userOnly = { sources: ["user"], projectSettings: false };
  assert.deepEqual(await sources(), both);
  assert.deepEqual(await sources({ cwd: dirname(h.cwd) }), userOnly, "Pi's trust does not cover another directory");
  h.caller.trusted = false;
  assert.deepEqual(await sources(), userOnly);

  // With nothing of its own to protect, Pi calls the folder trusted without having asked anyone.
  h.caller.trusted = true;
  h.withoutProtectedResources();
  assert.deepEqual(await sources(), userOnly, "hooks in .claude/settings.json do not run on trust nobody gave");
  h.saveTrust(true);
  assert.deepEqual(await sources(), both, "a decision saved with /trust is one");

  h.caller.projectTrust = false;
  assert.deepEqual(await sources(), userOnly, "a Pi that cannot say is treated as untrusted");
});

test("resume continues the named Claude Code session instead of starting one", async t => {
  const h = harness(t, reports("continued"));
  const { result, text } = await h.run({ task: "And the second file?", resume: SESSION });
  const [{ options }] = h.spawned;
  assert.equal(options.resume, SESSION);
  assert.equal(options.sessionId, undefined);
  assert.equal(options.title, undefined, "a resumed session keeps its title");
  assert.equal(result.details.sessionId, SESSION);
  assert.match(text, new RegExp(`session ${SESSION} \\(pass as "resume" to continue it\\)`));

  await assert.rejects(h.run({ task: "Again.", resume: "the last one" }), /resume must be a Claude Code session id/);
  await assert.rejects(h.run({ task: "Elsewhere.", cwd: "no-such-directory" }), /cwd is not a directory/);
  assert.equal(h.spawned.length, 1, "nothing starts on arguments that cannot work");
});

test("an edit reaches the user with the tool and the path, and each answer does what it says", async t => {
  const answered: (string | undefined)[] = [];
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    const notes = join(run.claude.options.cwd ?? "", "notes.txt");
    const edit = async (id: string, file_path: string): Promise<void> => {
      run.uses(`msg_${id}`, { id, name: "Edit", input: { file_path, old_string: "beta", new_string: "beta2" } });
      const answer = await run.asks(id, "Edit", { file_path, old_string: "beta", new_string: "beta2" });
      answered.push(answer?.behavior === "deny" ? `deny: ${answer.message}` : answer?.behavior);
      run.returns(id, answer?.behavior === "allow" ? "edited" : "refused", answer?.behavior !== "allow");
    };
    await edit("toolu_1", notes);
    await edit("toolu_2", notes);
    await edit("toolu_3", notes);
    await edit("toolu_4", join(run.claude.options.cwd ?? "", "src", "new.txt"));
    await edit("toolu_5", "/etc/hosts");
    await edit("toolu_6", "/etc/hosts");
    run.finished("Edited what I was allowed to.");
  });
  h.answers.push("Allow once", "Deny", /^Always allow edits under/, "Allow once");
  const { result, text } = await h.run({ task: "Rename beta.", access: "edit" });

  assert.deepEqual(answered.map(answer => answer?.replace(/:.*/, "")), ["allow", "deny", "allow", "allow", "allow", "deny"]);
  assert.equal(h.questions.length, 5, "the fourth edit was covered by the answer to the third");
  const [first, , third, , outside] = h.questions;
  assert.equal(first.title, `Claude Code asks to use Edit:\n\n  ${join(h.cwd, "notes.txt")}\n  - beta\n  + beta2\n\nWorking directory: ${h.cwd}`);
  assert.deepEqual(first.options, ["Allow once", `Always allow edits under ${h.cwd} for this session`, "Deny"]);
  assert.deepEqual(third.options, first.options);
  assert.match(outside.title, /\n {2}\/etc\/hosts\n/);
  assert.deepEqual(outside.options, ["Allow once", "Always allow edits under /etc for this session", "Deny"], "always inside the project says nothing about /etc");

  assert.match(answered[1] ?? "", /^deny: The user declined this Edit call\. Do not retry/);
  assert.match(answered[5] ?? "", /^deny: The user declined/, "a dismissed dialog is a refusal");
  assert.deepEqual(result.details.denials, [
    { id: "toolu_2", tool: "Edit", target: join(h.cwd, "notes.txt"), reason: "declined by the user" },
    { id: "toolu_6", tool: "Edit", target: "/etc/hosts", reason: "declined by the user" },
  ]);
  assert.deepEqual(result.details.tools.map(line => line.status), ["done", "denied", "done", "done", "done", "denied"]);
  assert.equal(result.details.tools[1].note, "declined by the user");
  assert.match(text, /\[not run: Edit .*notes\.txt \(declined by the user\); Edit \/etc\/hosts \(declined by the user\)\]$/);
});

test("an always answer lasts for the Pi session it was given in, across delegated runs", async t => {
  const shell = async (run: Run): Promise<void> => {
    await run.claude.user();
    run.init();
    run.uses("msg_1", { id: "toolu_1", name: "Bash", input: { command: "npm test", description: "Run the test suite" } });
    const answer = await run.asks("toolu_1", "Bash", { command: "npm test", description: "Run the test suite" });
    run.returns("toolu_1", answer?.behavior ?? "", answer?.behavior !== "allow");
    run.finished(answer?.behavior ?? "");
  };
  const h = harness(t, shell, shell, shell);
  h.answers.push("Always allow shell commands for this session");
  assert.equal((await h.run({ task: "Test.", access: "full" })).result.content[0].type, "text");
  assert.equal(h.questions[0].title, `Claude Code asks to use Bash:\n\n  npm test\n  Run the test suite\n\nWorking directory: ${h.cwd}`);
  assert.deepEqual(h.questions[0].options, ["Allow once", "Always allow shell commands for this session", "Deny"]);

  assert.match((await h.run({ task: "Test again.", access: "full" })).text, /^allow/);
  assert.equal(h.questions.length, 1, "the second run did not ask");

  h.caller.piSession = "pi-session-2";
  assert.match((await h.run({ task: "Test in a new session.", access: "full" })).text, /^deny/);
  assert.equal(h.questions.length, 2, "a new Pi session starts with nothing approved");
});

test("requests made at once are asked one at a time, and an always answer settles the ones waiting", async t => {
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    const answers = await Promise.all([
      run.asks("toolu_1", "Read", { file_path: "/etc/hostname" }, { decisionReason: "Path is outside allowed working directories" }),
      run.asks("toolu_2", "Read", { file_path: "/etc/hosts" }, { decisionReason: "Path is outside allowed working directories" }),
      run.asks("toolu_3", "WebFetch", { url: "https://example.com/a", prompt: "?" }, { defaultToNo: true }),
    ]);
    run.finished(answers.map(answer => answer?.behavior).join(" "));
  });
  h.answers.push(/^Always allow reading under/, /^Always allow fetching from/);
  const { text } = await h.run({ task: "Read the host files." });
  assert.match(text, /^allow allow allow/);
  assert.equal(h.questions.length, 2);
  assert.equal(h.questions[0].title, `Claude Code asks to use Read:\n\n  /etc/hostname\n\nPath is outside allowed working directories. Working directory: ${h.cwd}`);
  assert.deepEqual(h.questions[0].options, ["Allow once", "Always allow reading under /etc for this session", "Deny"]);
  assert.deepEqual(h.questions[1].options, ["Deny", "Allow once", "Always allow fetching from example.com for this session"],
    "a request Claude Code marks as risky opens on the refusal");
});

test("without a UI, whatever needs approval is refused with a reason the model can act on", async t => {
  const answered: string[] = [];
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    run.uses("msg_1", { id: "toolu_1", name: "Edit", input: { file_path: "notes.txt", old_string: "a", new_string: "b" } });
    const answer = await run.asks("toolu_1", "Edit", { file_path: "notes.txt", old_string: "a", new_string: "b" });
    answered.push(answer?.behavior === "deny" ? answer.message : "allowed");
    run.returns("toolu_1", "refused", true);
    run.finished("I could not edit notes.txt.");
  });
  h.caller.hasUI = false;
  const { result, text } = await h.run({ task: "Edit the notes.", access: "edit" });
  assert.equal(h.questions.length, 0);
  assert.match(answered[0], /^Edit needs the user's approval, and Pi is running without an interactive UI \(print or JSON mode\)/);
  assert.match(answered[0], /Do not retry/);
  assert.deepEqual(result.details.denials, [{ id: "toolu_1", tool: "Edit", target: join(h.cwd, "notes.txt"), reason: "no UI to approve it" }]);
  assert.match(text, /^I could not edit notes\.txt\./);
  assert.match(text, /\[not run: Edit .*notes\.txt \(no UI to approve it\)\]$/);
  assert.equal(result.isError, undefined, "the run itself finished");
});

test("a tool beyond the access level is refused without asking, even if something offers it", async t => {
  const answered: string[] = [];
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    for (const [id, name, input] of [["toolu_1", "Bash", { command: "rm -rf build" }], ["toolu_2", "Write", { file_path: "x.txt", content: "" }]] as const) {
      const answer = await run.asks(id, name, input);
      answered.push(answer?.behavior === "deny" ? answer.message : "allowed");
    }
    run.finished("Nothing changed.", { permission_denials: [
      { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "rm -rf build" } },
      { tool_name: "Read", tool_use_id: "toolu_9", tool_input: { file_path: "/etc/shadow" } },
    ] });
  });
  h.answers.push("Allow once", "Allow once");
  const { result } = await h.run({ task: "Tidy up." });
  assert.equal(h.questions.length, 0);
  assert.match(answered[0], /delegated with read access, which does not include Bash/);
  assert.match(answered[1], /delegated with read access, which does not include Write/);
  assert.deepEqual(result.details.denials, [
    { id: "toolu_1", tool: "Bash", target: "rm -rf build", reason: "needs full access" },
    { id: "toolu_2", tool: "Write", target: join(h.cwd, "x.txt"), reason: "needs edit access" },
    { id: "toolu_9", tool: "Read", target: "/etc/shadow", reason: "refused by Claude Code's own rules" },
  ], "refusals Claude Code made by itself are on the record too, once each");
});

test("progress arrives as one line per tool and the latest text", async t => {
  const h = harness(t, async run => {
    await run.claude.user();
    run.init("claude-haiku-5-5");
    run.says("msg_1", "I'll count the lines.");
    run.uses("msg_2", { id: "toolu_1", name: "Read", input: { file_path: join(run.claude.options.cwd ?? "", "notes.txt") } });
    run.returns("toolu_1", "alpha\nbeta\ngamma");
    run.uses("msg_3", { id: "toolu_2", name: "Grep", input: { pattern: "beta", path: "src" } });
    run.returns("toolu_2", "No such file", true);
    run.says("msg_4", "notes.txt has 3 lines.");
    run.finished("notes.txt has 3 lines.", { num_turns: 4 });
  });
  const { updates } = await h.run({ task: "Count the lines in notes.txt." });
  const seen = updates.map(update => ({
    text: update.content[0].type === "text" ? update.content[0].text : "",
    tools: update.details.tools.map(line => `${line.name} ${line.summary} [${line.status}]`),
  }));
  assert.deepEqual(seen, [
    { text: "Claude Code is working…", tools: [] },
    { text: "I'll count the lines.", tools: [] },
    { text: "I'll count the lines.", tools: ["Read notes.txt [running]"] },
    { text: "I'll count the lines.", tools: ["Read notes.txt [done]"] },
    { text: "I'll count the lines.", tools: ["Read notes.txt [done]", "Grep beta in src [running]"] },
    { text: "I'll count the lines.", tools: ["Read notes.txt [done]", "Grep beta in src [failed]"] },
    { text: "notes.txt has 3 lines.", tools: ["Read notes.txt [done]", "Grep beta in src [failed]"] },
  ]);
  assert.ok(updates.every(update => update.details.status === "running" && update.details.sessionId === SESSION));
  assert.equal(updates[0].details.model, "claude-haiku-5-5");
  assert.deepEqual(updates.at(-1)?.details.usage, { input: 26, output: 24, cacheRead: 200, cacheWrite: 40 }, "tokens so far");
  assert.notEqual(updates[2].details.tools, updates[3].details.tools, "each update is a snapshot");
});

test("the result is Claude Code's report, with the session, the counts and the tokens of the run", async t => {
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    run.rateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 });
    run.uses("msg_1", { id: "toolu_1", name: "Bash", input: { command: "wc -l notes.txt" } });
    await run.asks("toolu_1", "Bash", { command: "wc -l notes.txt" });
    run.returns("toolu_1", "3 notes.txt");
    run.says("msg_2", "notes.txt has 3 lines.");
    run.finished("notes.txt has 3 lines.", { num_turns: 2, modelUsage: { "claude-haiku-5-5": { inputTokens: 13 } } });
  });
  h.answers.push("Allow once");
  const { result, text } = await h.run({ task: "Count the lines in notes.txt.", access: "full" });

  assert.equal(text, `notes.txt has 3 lines.\n\n[claude_code: session ${SESSION} (pass as "resume" to continue it) · 2 turns · 1 tool call]`);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    status: "done", sessionId: SESSION, model: "claude-haiku-5-5", access: "full", cwd: h.cwd, projectSettings: true,
    turns: 2, toolCount: 1, tools: [{ id: "toolu_1", name: "Bash", summary: "$ wc -l notes.txt", status: "done" }], denials: [],
    usage: { input: 13, output: 12, cacheRead: 100, cacheWrite: 20 }, text: "",
  });
  // Pi adds this to the session totals. A subscription is not billed per token.
  assert.deepEqual(result.usage, {
    input: 13, output: 12, cacheRead: 100, cacheWrite: 20, totalTokens: 145,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.deepEqual(h.rateLimits, [{ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 }]);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].session_id, SESSION);
  assert.equal(h.spawned[0].closed, true, "nothing is left running");
  assert.deepEqual(h.spawned[0].failures, []);
});

test("aborting interrupts Claude Code, closes it and leaves a session that can be resumed", async t => {
  const controller = new AbortController();
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    run.says("msg_1", "Reading the files first.");
    run.uses("msg_2", { id: "toolu_1", name: "Read", input: { file_path: "notes.txt" } });
    await run.claude.interrupted();
    run.finished("", { subtype: "error_during_execution", is_error: true, errors: [] });
  });
  // The user presses Escape while the first tool is running.
  const { result, text } = await h.run({ task: "Survey everything." }, controller.signal, partial => {
    if (partial.details.tools.length) controller.abort();
  });
  assert.equal(h.spawned[0].interrupts, 1);
  assert.equal(h.spawned[0].closed, true);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "aborted");
  assert.deepEqual(result.details.tools.map(line => line.status), ["failed"], "a call cut short did not finish");
  assert.match(text, /^Aborted\. Claude Code was stopped; what it did so far is kept in the session\.\n\nIts last message:\nReading the files first\./);
  assert.match(text, new RegExp(`session ${SESSION}`));
  assert.deepEqual(result.usage?.input, 13, "what the run used before it stopped still counts");
  assert.equal(h.results.length, 1);
});

test("an abort that Claude Code does not answer still ends the tool, and one before the start spawns nothing", async t => {
  const controller = new AbortController();
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    controller.abort();
    // No result follows the interrupt.
  });
  const { result } = await h.run({ task: "Hang." }, controller.signal);
  assert.equal(result.details.status, "aborted");
  assert.equal(h.spawned[0].interrupts, 1);
  assert.equal(h.spawned[0].closed, true);

  const before = await h.run({ task: "Never starts." }, controller.signal);
  assert.equal(before.result.isError, true);
  assert.match(before.text, /^Aborted before Claude Code started\./);
  assert.equal(h.spawned.length, 1);
});

test("a failure comes back as a failed result that says what to do", async t => {
  const h = harness(t,
    async run => {
      run.claude.account = { apiKeySource: "ANTHROPIC_API_KEY" };
    },
    async run => {
      await run.claude.user();
      run.init();
      run.claude.apiError("You've hit your session limit · resets 3pm", "rate_limit");
    },
    async run => {
      await run.claude.user();
      run.init();
      run.says("msg_1", "Halfway through the files.");
      run.finished("", { subtype: "error_max_turns", is_error: true, num_turns: 3, errors: [] });
    },
    async run => {
      await run.claude.user();
      run.init();
      run.claude.options.stderr?.("error: unknown option\n");
      run.claude.close();
    },
    async run => {
      await run.claude.user();
      run.finished("", { subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: x"] });
    },
  );
  const signedOut = await h.run({ task: "Look." });
  assert.equal(signedOut.result.isError, true);
  assert.equal(signedOut.result.details.status, "failed");
  assert.match(signedOut.text, /^Claude Code is not signed in with a Claude subscription \(it is using an API key from ANTHROPIC_API_KEY\)\. Run `claude auth login`/);
  assert.deepEqual(h.spawned[0].received, [], "the task is not sent to a login that bills per token");
  assert.equal(h.spawned[0].closed, true);

  const limited = await h.run({ task: "Look." });
  assert.equal(limited.result.isError, true);
  assert.match(limited.text, /^You've hit your session limit · resets 3pm The Claude plan limit was reached: wait for it to reset/);

  const cut = await h.run({ task: "Look.", maxTurns: 3 });
  assert.equal(cut.result.isError, true);
  assert.match(cut.text, /^Claude Code stopped after 3 turns without finishing\. Resume the session to let it continue, or raise maxTurns\.\n\nIts last message:\nHalfway through the files\./);
  assert.match(cut.text, new RegExp(`session ${SESSION}`));

  const exited = await h.run({ task: "Look." });
  assert.equal(exited.result.isError, true);
  assert.match(exited.text, /^Claude Code exited before finishing the task\. error: unknown option The session can be resumed\./);

  const missing = await h.run({ task: "Look.", resume: SESSION });
  assert.match(missing.text, /^No conversation found with session ID: x/);
  assert.ok(h.spawned.every(claude => claude.closed));
});

test("the card is compact when collapsed and holds the tool list and the report when expanded", async t => {
  const h = harness(t, async run => {
    await run.claude.user();
    run.init();
    for (let index = 1; index <= 5; index++) {
      run.uses(`msg_${index}`, { id: `toolu_${index}`, name: "Read", input: { file_path: `src/file-${index}.ts` } });
      run.returns(`toolu_${index}`, "contents");
    }
    run.finished(["# Survey", "", ...Array.from({ length: 8 }, (_, index) => `Finding ${index + 1} about \x1b[31mthe code\x1b[0m.`)].join("\n"), { num_turns: 6 });
  });
  const { result, updates } = await h.run({ task: "Survey the source tree and list what each file is for.\nBe brief.", model: "haiku" });
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const state = { expanded: false } as Parameters<NonNullable<typeof h.tool.renderCall>>[2];
  const lines = (component: { render(width: number): string[] }, width = 60): string[] =>
    component.render(width).map(line => stripVTControlCharacters(line).trimEnd());

  const call = lines(h.tool.renderCall!({ task: "Survey the source tree and list what each file is for.\nBe brief.", model: "haiku" }, theme, state));
  assert.deepEqual(call, ["claude_code read · haiku", "Survey the source tree and list what each file is for.", "Be brief."]);

  const working = lines(h.tool.renderResult!(updates[3], { expanded: false, isPartial: true }, theme, state));
  assert.deepEqual(working, ["● working · 2 turns · 2 tool calls · ↑20 ↓10", "→ Read src/file-1.ts", "→ Read src/file-2.ts"]);

  const collapsed = lines(h.tool.renderResult!(result, { expanded: false, isPartial: false }, theme, state));
  assert.equal(collapsed[0], "✓ done · 6 turns · 5 tool calls · ↑50 ↓25");
  assert.deepEqual(collapsed.slice(1, 5), ["… 2 earlier tool calls", "→ Read src/file-3.ts", "→ Read src/file-4.ts", "→ Read src/file-5.ts"]);
  assert.deepEqual(collapsed.slice(5, 9), ["# Survey", "", "Finding 1 about the code.", "Finding 2 about the code."], "terminal escapes in the report are not passed on");
  assert.match(collapsed[9], /^… \(.*for the tool list and the full report\)$/);
  assert.equal(collapsed.length, 10);

  const expanded = lines(h.tool.renderResult!(result, { expanded: true, isPartial: false }, theme, state), 200);
  assert.equal(expanded[1], `session ${SESSION} · claude-haiku-5-5 · read access · ${h.cwd} · user and project settings`);
  assert.deepEqual(expanded.slice(2, 7), [1, 2, 3, 4, 5].map(index => `→ Read src/file-${index}.ts`));
  assert.ok(expanded.includes("Finding 8 about the code."));
  assert.match(expanded.at(-1) ?? "", /^\[claude_code: session /);

  for (const width of [1, 7, 24]) {
    const narrow = h.tool.renderResult!(result, { expanded: true, isPartial: false }, theme, state).render(width);
    assert.ok(narrow.every(line => stripVTControlCharacters(line).length <= width), `every line fits ${width} columns`);
  }
  const refusedCall = { ...result, details: {
    ...result.details,
    tools: [{ id: "toolu_6", name: "Edit", summary: "notes.txt", status: "denied" as const, note: "declined by the user" }],
    denials: [
      { id: "toolu_6", tool: "Edit", target: join(h.cwd, "notes.txt"), reason: "declined by the user" },
      { id: "toolu_0", tool: "Bash", target: "rm -rf build", reason: "needs full access" },
    ],
  } };
  const refusals = lines(h.tool.renderResult!(refusedCall, { expanded: true, isPartial: false }, theme, state), 200);
  assert.match(refusals[0], /· 2 not run$/);
  assert.deepEqual(refusals.slice(2, 5), ["… 4 earlier tool calls", "⊘ Edit notes.txt (declined by the user)", "⊘ Bash rm -rf build (needs full access)"]);

  // A result with no record of a run, as when Pi blocks the call, is shown as its text.
  const blocked = { content: [{ type: "text" as const, text: "claude_code was not approved" }], details: undefined as never };
  assert.deepEqual(lines(h.tool.renderResult!(blocked, { expanded: false, isPartial: false }, theme, state)), ["claude_code was not approved"]);
});
