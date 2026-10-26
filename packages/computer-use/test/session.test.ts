import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ComputerSession } from '../extensions/computer-use/src/session.js';
import type { Installation } from '../extensions/computer-use/src/installation.js';
import { present } from '../extensions/computer-use/src/result.js';

const server = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

async function fixture(timeout = 5000, startupTimeout = 2000, extra: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-computer-session-'));
  const log = join(directory, 'requests');
  const detect = (): Installation => ({ available: true, mode: 'local', chatgptApp: '/fixture/ChatGPT.app', companionApp: '/fixture/Companion.app', launch: {
    command: process.execPath, args: [server, log, ...extra], env: {}, cwd: directory,
  } });
  const session = new ComputerSession(detect, timeout, startupTimeout);
  const messages = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { session, log, detect, messages, close: async () => { await session.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function waitFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try { return await readFile(path, 'utf8'); } catch { await delay(10); }
  }
  throw new Error(`Fixture did not create ${path}`);
}

async function stopped(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    // Linux can briefly retain an orphan as a zombie; it is no longer executing.
    try { if ((await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z') return; } catch {}
    await delay(10);
  }
  assert.fail(`Owned process ${pid} is still executing`);
}

test('starts lazily, keeps one runtime, and maps ordinary text, images and errors', async () => {
  const f = await fixture();
  try {
    assert.equal(f.session.connected, false);
    await assert.rejects(readFile(f.log + '.pid'));
    const first = await present(await f.session.execute({ code: 'state', title: 'State' }));
    assert.deepEqual(first.content.map(block => block.type), ['text', 'image']);
    assert.equal(first.details.isError, false);
    const second = await f.session.execute({ code: 'state' });
    assert.equal((second.content[0] as { text: string }).text, 'state 2');
    const error = await present(await f.session.execute({ code: 'error' }));
    assert.equal(error.isError, true);
    assert.equal(error.details.isError, true);
    assert.equal(error.content[1].type, 'image');
    assert.equal((await f.messages()).filter(message => message.method === 'initialize').length, 1);
  } finally { await f.close(); }
});

test('headless calls acknowledge app consent without UI and never persist always', async () => {
  const f = await fixture();
  try {
    const first = await f.session.execute({ code: 'consent' });
    assert.deepEqual(first.structuredContent, { action: 'accept', content: {}, _meta: { persist: 'session' } });
    const second = await f.session.execute({ code: 'click' });
    assert.deepEqual(second.structuredContent, { action: 'accept', content: { source: 'computer-use-persisted-state' }, _meta: { persist: 'session' } });
    assert.deepEqual((await f.session.execute({ code: 'other-app' })).structuredContent?.content, {});
    assert.equal((await f.session.execute({ code: 'form' })).structuredContent?.action, 'decline');
    await f.session.close();
    assert.deepEqual((await f.session.execute({ code: 'consent' })).structuredContent?.content, {});
  } finally { await f.close(); }
});

test('notifies host cleanup at the end of a used turn only', async () => {
  const f = await fixture();
  try {
    await f.session.endTurn('session', 'unused');
    await assert.rejects(readFile(f.log));
    await f.session.execute({ code: 'state' });
    await f.session.endTurn('session', 'turn');
    await f.session.endTurn('session', 'turn');
    const hooks = (await f.messages()).filter(message => message.params?.name === 'turn_ended');
    assert.equal(hooks.length, 1);
    assert.deepEqual(hooks[0].params.arguments, { hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn' });
  } finally { await f.close(); }
});

test('cancellation rejects overlapping work and terminates launcher and worker without replay', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const running = f.session.execute({ code: 'hang' }, abort.signal);
    const rejected = assert.rejects(running, /may have partially completed/);
    const worker = Number(await waitFile(f.log + '.worker'));
    const launcher = Number(await waitFile(f.log + '.pid'));
    await assert.rejects(f.session.execute({ code: 'state' }), /busy/);
    abort.abort();
    await rejected;
    await stopped(launcher); await stopped(worker);
    assert.equal((await f.messages()).filter(message => message.method === 'tools/call').length, 1);
    assert.equal(f.session.connected, false);
  } finally { await f.close(); }
});

test('deadline and reset abort pending requests and clean up their process groups', async () => {
  for (const reset of [false, true]) {
    const f = await fixture(reset ? 5000 : 500);
    try {
      const running = f.session.execute({ code: 'hang' });
      const rejected = assert.rejects(running, /may have partially completed/);
      const worker = Number(await waitFile(f.log + '.worker'));
      if (reset) await f.session.close();
      await rejected;
      await stopped(worker);
      assert.equal(f.session.connected, false);
      const state = await f.session.execute({ code: 'state' });
      assert.equal((state.content[0] as { text: string }).text, 'state 1');
    } finally { await f.close(); }
  }
});

test('startup timeout stops the process; unsupported or removed installations never launch', async () => {
  const f = await fixture(5000, 100, ['--hang-startup']);
  try {
    await assert.rejects(f.session.execute({ code: 'state' }), /Computer Use failed/);
    await stopped(Number(await waitFile(f.log + '.pid')));
    assert.equal((await f.messages()).filter(message => message.method === 'tools/call').length, 0);
  } finally { await f.close(); }
  const session = new ComputerSession(() => ({ available: false, reason: 'Companion missing' }));
  await assert.rejects(session.execute({ code: 'state' }), /Companion missing/);
  await session.close();
});

test('already-cancelled and invalid code calls never spawn', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.session.execute({ code: 'state' }, AbortSignal.abort()), /abort/i);
    await assert.rejects(f.session.execute({ code: '  ' }), /non-empty/);
    await assert.rejects(f.session.execute({ code: 'state', timeout_ms: 120001 }), /timeout_ms/);
    await assert.rejects(readFile(f.log + '.pid'));
  } finally { await f.close(); }
});

test('large Unicode results have a recoverable bounded preview without private metadata', async () => {
  const raw = { content: [{ type: 'text' as const, text: '€'.repeat(30_000) }], _meta: { private: 'fixture' } };
  const result = await present(raw);
  assert.ok(result.details.fullOutput);
  try {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(Buffer.byteLength(text) < 50 * 1024);
    assert.ok(!text.includes('\ufffd'));
    const recovered = JSON.parse(await readFile(result.details.fullOutput, 'utf8'));
    assert.deepEqual(recovered.content, raw.content);
    assert.equal(recovered._meta, undefined);
  } finally { await rm(join(result.details.fullOutput, '..'), { recursive: true, force: true }); }
});
