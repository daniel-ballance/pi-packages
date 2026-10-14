import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext, Type, type AssistantMessage, type Message, type Tool } from "@earendil-works/pi-ai";
import type { Thinking } from "../extensions/claude-subscription/src/models.js";
import { keysDigest, lookupResume, resumable, SessionStore, verifySession, type SessionReader, type SessionRecord } from "../extensions/claude-subscription/src/resume.js";
import { readTranscript, type Transcript } from "../extensions/claude-subscription/src/transcript.js";

const CWD = "/tmp/pi-resume-project";
const THINKING: Thinking = { thinking: { type: "adaptive", display: "summarized" }, effort: "high" };
const TOOLS: Tool[] = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

function assistant(content = "done", overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: content }], api: "claude-agent-sdk", provider: "claude-subscription", model: "claude-haiku-5-5", responseId: `msg_${content}`, usage, stopReason: "stop", timestamp: 1, ...overrides };
}

function read(messages: Message[], systemPrompt = "You are Pi.", tools = TOOLS): Transcript {
  return readTranscript(normalizeContext({ systemPrompt, messages, tools }));
}

function record(transcript: Transcript, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session-one", cwd: CWD, leadingKey: transcript.leadingKey, toolsKey: transcript.toolsKey,
    thinkingKey: JSON.stringify(THINKING.thinking), keys: transcript.entries.map(entry => entry.key), lastUuid: "last-one", paused: false,
    ...overrides,
  };
}

const PAST = [user("hello"), assistant()];
const BASE = read(PAST);
const REQUEST = read([...PAST, user("continue")]);

function sdkMessage(type: SessionMessage["type"], content: unknown, uuid = "last-one"): SessionMessage {
  return { type, uuid, session_id: "session-one", parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } };
}

const clean: SessionReader = async () => [sdkMessage("assistant", [{ type: "thinking", thinking: "private", signature: "signed" }, { type: "text", text: "done" }])];

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cs-resume-test-"));
  t.after(async () => {
    await chmod(path, 0o700);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function filename(path: string, value: SessionRecord): string {
  return join(path, `${keysDigest(value.keys)}.json`);
}

test("resume requires the original working directory", () => {
  assert.equal(resumable(record(BASE), REQUEST, THINKING, `${CWD}-other`), undefined);
  assert.deepEqual(resumable(record(BASE), REQUEST, THINKING, CWD), REQUEST.entries.slice(2));
});

test("resume requires the same leading system prompt", () => {
  assert.equal(resumable(record(BASE), read([...PAST, user("continue")], "Different prompt."), THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("resume requires the same tools including their schemas", () => {
  assert.equal(resumable(record(BASE), read([...PAST, user("continue")], "You are Pi.", []), THINKING, CWD), undefined);
  assert.equal(resumable(record(BASE), read([...PAST, user("continue")], "You are Pi.", [{ ...TOOLS[0], description: "Changed schema" }]), THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("resume requires the same thinking configuration", () => {
  assert.equal(resumable(record(BASE), REQUEST, { thinking: { type: "disabled" } }, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
  const budget: Thinking = { thinking: { type: "enabled", budgetTokens: 1024 } };
  const saved = record(BASE, { thinkingKey: JSON.stringify(budget.thinking) });
  assert.ok(resumable(saved, REQUEST, budget, CWD));
  assert.equal(resumable(saved, REQUEST, { thinking: { type: "enabled", budgetTokens: 2048 } }, CWD), undefined);
});

test("effort may change as on a live session", () => {
  assert.ok(resumable(record(BASE), REQUEST, { ...THINKING, effort: "low" }, CWD));
});

test("a model change does not change resume eligibility", () => {
  const changed = read([user("hello"), assistant("done", { model: "claude-sonnet-5-5" }), user("continue")]);
  assert.ok(resumable(record(BASE), changed, THINKING, CWD));
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("recorded entries must be exactly the transcript prefix", () => {
  assert.equal(resumable(record(BASE), read([user("edited"), assistant(), user("continue")]), THINKING, CWD), undefined);
  assert.equal(resumable(record(read([assistant(), user("hello")])), REQUEST, THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("the request must extend the recorded transcript", () => {
  assert.equal(resumable(record(BASE), BASE, THINKING, CWD), undefined);
  assert.equal(resumable(record(REQUEST), BASE, THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("a paused session cannot resume after restart", () => {
  assert.equal(resumable(record(BASE, { paused: true }), REQUEST, THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE, { paused: false }), REQUEST, THINKING, CWD));
});

test("fresh assistant entries require replay", () => {
  assert.equal(resumable(record(BASE), read([...PAST, assistant("another"), user("continue")]), THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("fresh tool results cannot answer a session after restart", () => {
  const call = assistant("call", { stopReason: "toolUse", content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }] });
  const before = read([user("read"), call]);
  const result: Message = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 1 };
  assert.equal(resumable(record(before), read([user("read"), call, result, user("continue")]), THINKING, CWD), undefined);
  assert.ok(resumable(record(BASE), REQUEST, THINKING, CWD));
});

test("new system updates can accompany input but cannot initiate a turn alone", () => {
  const update: Message = { role: "system", content: "Plan mode is on.", timestamp: 2 };
  assert.equal(resumable(record(BASE), read([...PAST, update]), THINKING, CWD), undefined);
  const request = read([...PAST, update, user("continue")]);
  assert.deepEqual(resumable(record(BASE), request, THINKING, CWD), request.entries.slice(2));
});

test("lookup chooses the longest matching prefix and ignores a longer different conversation", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  const messages = [user("one"), user("two"), user("three"), user("four")];
  const short = record(read(messages.slice(0, 1)), { sessionId: "short" });
  const long = record(read(messages.slice(0, 2)), { sessionId: "long" });
  const other = record(read([user("one"), user("different"), user("three")]), { sessionId: "other" });
  for (const saved of [short, long, other]) assert.equal(await store.save(saved), true);
  const visited: string[] = [];
  const found = await lookupResume(new SessionStore(path), read(messages), THINKING, CWD, async (id, options) => {
    visited.push(id);
    assert.deepEqual(options, { dir: CWD });
    return clean(id, options);
  });
  assert.equal(found?.record.sessionId, "long");
  assert.deepEqual(found?.fresh, read(messages).entries.slice(2));
  assert.deepEqual(visited, ["long"]);
});

test("lookup tries a shorter candidate when the longest chain cannot be verified", async t => {
  const store = new SessionStore(await directory(t));
  const messages = [user("one"), user("two"), user("three")];
  await store.save(record(read(messages.slice(0, 1)), { sessionId: "short" }));
  await store.save(record(read(messages.slice(0, 2)), { sessionId: "long" }));
  const found = await lookupResume(store, read(messages), THINKING, CWD, async (id, options) => id === "long" ? [] : clean(id, options));
  assert.equal(found?.record.sessionId, "short");
});

test("lookup tries a shorter candidate when the longest has incompatible settings", async t => {
  const store = new SessionStore(await directory(t));
  const messages = [user("one"), user("two"), user("three")];
  await store.save(record(read(messages.slice(0, 1)), { sessionId: "short" }));
  await store.save(record(read(messages.slice(0, 2), "Changed prompt."), { sessionId: "long" }));
  assert.equal((await lookupResume(store, read(messages), THINKING, CWD, clean))?.record.sessionId, "short");
});

test("a session moving on replaces its previous record even after reopening the store", async t => {
  const path = await directory(t);
  const old = record(BASE);
  const next = record(read([...PAST, user("continue"), assistant("next")]));
  assert.equal(await new SessionStore(path).save(old), true);
  const store = new SessionStore(path);
  assert.equal(await store.save(next), true);
  assert.deepEqual(await readdir(path), [`${keysDigest(next.keys)}.json`]);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  const found = await lookupResume(store, read([...PAST, user("continue"), assistant("next"), user("again")]), THINKING, CWD, clean);
  assert.deepEqual(found?.record, next);
});

test("two extensions of a forked Pi prefix resolve to their respective Claude Code sessions", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  const left = [...PAST, user("left"), assistant("left answer")];
  const right = [...PAST, user("right"), assistant("right answer")];
  await store.save(record(BASE, { sessionId: "parent" }));
  await store.save(record(read(left), { sessionId: "left" }));
  await store.save(record(read(right), { sessionId: "right" }));
  const reopened = new SessionStore(path);
  assert.equal((await lookupResume(reopened, read([...left, user("again")]), THINKING, CWD, clean))?.record.sessionId, "left");
  assert.equal((await lookupResume(reopened, read([...right, user("again")]), THINKING, CWD, clean))?.record.sessionId, "right");
});

test("advancing a session does not remove another session that now owns its former prefix file", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  await store.save(record(BASE, { sessionId: "original" }));
  await new SessionStore(path).save(record(BASE, { sessionId: "replacement" }));
  await store.save(record(read([...PAST, user("continue"), assistant("next")]), { sessionId: "original" }));
  assert.equal((await lookupResume(store, REQUEST, THINKING, CWD, clean))?.record.sessionId, "replacement");
});

test("malformed truncated and foreign files are absent and left alone", async t => {
  const path = await directory(t);
  const broken = `${keysDigest(BASE.entries.map(entry => entry.key))}.json`;
  await writeFile(join(path, broken), "{\"version\":1,\"record\":");
  await writeFile(join(path, "notes.txt"), "foreign");
  await writeFile(join(path, ".record-crashed.tmp"), "{\"version\":1,");
  await writeFile(join(path, `${keysDigest([])}.json`), JSON.stringify({ version: 1, updatedAt: Date.now(), record: { sessionId: 7 } }));
  const store = new SessionStore(path);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  await writeFile(join(path, broken), "not json");
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  assert.equal(await readFile(join(path, "notes.txt"), "utf8"), "foreign");
  assert.equal(await readFile(join(path, ".record-crashed.tmp"), "utf8"), "{\"version\":1,");
});

test("records filed under the wrong digest and unknown versions are absent", async t => {
  const path = await directory(t);
  await writeFile(filename(path, record(BASE)), JSON.stringify({ version: 1, updatedAt: Date.now(), record: record(read([user("other")])) }));
  const store = new SessionStore(path);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  await writeFile(filename(path, record(BASE)), JSON.stringify({ version: 2, updatedAt: Date.now(), record: record(BASE) }));
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
});

test("unreadable records and symbolic links are treated as absent", async t => {
  const path = await directory(t);
  const value = record(BASE);
  const store = new SessionStore(path);
  await store.save(value);
  await chmod(filename(path, value), 0);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  await rm(filename(path, value));
  await writeFile(join(path, "foreign.json"), JSON.stringify({ version: 1, updatedAt: Date.now(), record: value }));
  await symlink(join(path, "foreign.json"), filename(path, value));
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
});

test("the store creates a private directory and atomically publishes private files", async t => {
  const path = join(await directory(t), "sessions");
  const store = new SessionStore(path);
  await store.save(record(BASE));
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(filename(path, record(BASE)))).mode & 0o777, 0o600);
  const envelope = JSON.parse(await readFile(filename(path, record(BASE)), "utf8"));
  assert.deepEqual(envelope.record, record(BASE));
  assert.deepEqual(await readdir(path), [`${keysDigest(record(BASE).keys)}.json`]);
  await chmod(path, 0o755);
  await chmod(filename(path, record(BASE)), 0o644);
  await new SessionStore(path).save(record(BASE));
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(filename(path, record(BASE)))).mode & 0o777, 0o600);
});

test("records older than thirty days expire and are removed opportunistically", async t => {
  const path = await directory(t);
  let now = 1_000;
  const store = new SessionStore(path, () => now);
  await store.save(record(BASE));
  now += 30 * 24 * 60 * 60 * 1_000;
  assert.ok(await lookupResume(store, REQUEST, THINKING, CWD, clean), "exactly thirty days is still retained");
  now++;
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  assert.deepEqual(await readdir(path), []);
});

test("opening the store sweeps expired records from unrelated conversations too", async t => {
  const path = await directory(t);
  await new SessionStore(path, () => 1).save(record(read([user("other")])));
  const store = new SessionStore(path, () => 31 * 24 * 60 * 60 * 1_000);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  assert.deepEqual(await readdir(path), []);
});

test("an unwritable directory disables resume and never fails the request", async t => {
  const path = await directory(t);
  await new SessionStore(path).save(record(BASE));
  await chmod(path, 0o500);
  const store = new SessionStore(path);
  assert.equal(await store.save(record(BASE)), false);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o500);
});

test("a path that is a file degrades to no resume", async t => {
  const path = join(await directory(t), "file");
  await writeFile(path, "foreign");
  const store = new SessionStore(path);
  assert.equal(await store.save(record(BASE)), false);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
});

test("a failed write disables further resume on that store", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  await store.save(record(BASE));
  await chmod(path, 0o500);
  assert.equal(await store.save(record(REQUEST)), false);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
});

test("a store made unwritable after initialization cannot resume its existing records", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  await store.save(record(BASE));
  await chmod(path, 0o500);
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, clean), undefined);
});

test("simultaneous saves serialize publication and snapshot mutable session keys", async t => {
  const path = await directory(t);
  const store = new SessionStore(path);
  const first = record(BASE);
  const one = store.save(first);
  first.keys.push(...REQUEST.entries.slice(2).map(entry => entry.key));
  const two = store.save(record(REQUEST));
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.deepEqual(await readdir(path), [`${keysDigest(record(REQUEST).keys)}.json`]);
});

test("verification accepts a matching clean chain including real tool results and signed thinking", async () => {
  const chain = [
    sdkMessage("assistant", [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }], "call"),
    sdkMessage("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }], "result"),
    ...(await clean("session-one", { dir: CWD })),
  ];
  assert.equal(await verifySession(record(BASE), async (id, options) => {
    assert.equal(id, "session-one");
    assert.deepEqual(options, { dir: CWD });
    return chain;
  }), true);
});

test("verification rejects an empty or deleted session", async () => {
  assert.equal(await verifySession(record(BASE), async () => []), false);
});

test("verification rejects a chain whose last uuid changed", async () => {
  assert.equal(await verifySession(record(BASE, { lastUuid: "older" }), clean), false);
});

test("verification rejects an unanswered tool use even when its uuid matches", async () => {
  assert.equal(await verifySession(record(BASE), async () => [sdkMessage("assistant", [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }])]), false);
});

test("verification rejects a partly answered set of tool calls", async () => {
  assert.equal(await verifySession(record(BASE), async () => [
    sdkMessage("assistant", [{ type: "tool_use", id: "one" }, { type: "tool_use", id: "two" }], "call"),
    sdkMessage("user", [{ type: "tool_result", tool_use_id: "one", content: "ok" }]),
  ]), false);
});

for (const interruption of [
  "The tool call was interrupted before a result was received. Please try again.",
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
]) {
  test(`verification rejects synthetic tool closure: ${interruption.split(":")[0]}`, async () => {
    assert.equal(await verifySession(record(BASE), async () => [
      sdkMessage("assistant", [{ type: "tool_use", id: "one" }], "call"),
      sdkMessage("user", [{ type: "tool_result", tool_use_id: "one", content: [{ type: "text", text: interruption }] }]),
    ]), false);
  });
}

test("verification rejects the CLI's synthetic no-response assistant tail", async () => {
  assert.equal(await verifySession(record(BASE), async () => [sdkMessage("assistant", "No response requested.")]), false);
});

test("a synthetic closure stays unverified through a retry until a genuine new user turn", async () => {
  const chain = [
    sdkMessage("assistant", [{ type: "tool_use", id: "one" }], "call"),
    sdkMessage("user", [{ type: "tool_result", tool_use_id: "one", content: "The tool call was interrupted before a result was received." }], "result"),
    sdkMessage("assistant", [{ type: "text", text: "I'll retry" }]),
  ];
  assert.equal(await verifySession(record(BASE), async () => chain), false);
  assert.equal(await verifySession(record(BASE), async () => [...chain, sdkMessage("user", "new turn", "new-user"), ...(await clean("session-one", { dir: CWD }))]), true);
});

test("verification rejects reader errors and malformed message data", async () => {
  assert.equal(await verifySession(record(BASE), async () => { throw new Error("unreadable"); }), false);
  assert.equal(await verifySession(record(BASE), async () => [{ ...sdkMessage("assistant", "done"), message: null }]), false);
  assert.equal(await verifySession(record(BASE), async () => [sdkMessage("assistant", undefined)]), false);
});

test("lookup returns no resume when every candidate fails verification", async t => {
  const store = new SessionStore(await directory(t));
  await store.save(record(BASE));
  assert.equal(await lookupResume(store, REQUEST, THINKING, CWD, async () => { throw new Error("missing"); }), undefined);
});
