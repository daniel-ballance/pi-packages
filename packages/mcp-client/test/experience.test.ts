import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { failureReason } from '../src/diagnostics.js';
import { validator, validationIssue } from '../src/validation.js';
import { searchScore } from '../src/search.js';
import { withProgress } from '../src/progress.js';
import { RpcError } from '../src/peer.js';

test('configuration diagnostics identify the file and field without quoting secret values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-diagnostics-'));
  const path = join(dir, 'mcp.json');
  try {
    await writeFile(path, '{"secret":"do-not-leak",broken}');
    await assert.rejects(loadConfig([path]), (error) => {
      assert.match(failureReason(error), /Invalid JSON.*mcp.json/);
      assert.doesNotMatch(failureReason(error), /do-not-leak/);
      return true;
    });
    await writeFile(
      path,
      JSON.stringify({
        servers: { example: { transport: 'stdio', command: 'test', timeout: 'do-not-leak' } },
      }),
    );
    await assert.rejects(loadConfig([path]), (error) => {
      assert.match(failureReason(error), /servers.example.timeout: invalid_type/);
      assert.doesNotMatch(failureReason(error), /do-not-leak/);
      return true;
    });
    assert.equal(
      failureReason(new RpcError(-32603, 'do-not-leak')),
      'Server returned RPC error -32603',
    );
    assert.doesNotMatch(failureReason(new Error('do-not-leak')), /do-not-leak/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validation explains constraint location without argument values or schema enums', () => {
  const validate = validator({
    type: 'object',
    properties: { password: { enum: ['schema-secret'] } },
    required: ['password'],
  });
  assert.equal(validate({}), false);
  assert.equal(validationIssue(validate), '/password: required constraint failed');
  assert.equal(validate({ password: 'argument-secret' }), false);
  assert.equal(validationIssue(validate), '/password: enum constraint failed');
});

test('search prioritizes exact names and titles over incidental descriptions', () => {
  const score = (name: string, title: string, description: string) =>
    searchScore('take screenshot', 'browser', name, title, description);
  assert.ok(score('take_screenshot', '', '') > score('other', '', 'take screenshot'));
  assert.ok(score('other', 'Take screenshot', '') > score('other', '', 'take screenshot'));
  assert.equal(searchScore('', 'server', 'tool', 'title', 'description'), 0);
  assert.equal(searchScore('missing', 'server', 'tool', 'title', 'description'), 0);
});

test('progress is delayed, bounded, labelled, and stops after completion or failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const updates: string[] = [];
  let finish!: (result: number) => void;
  let progress!: (value: Record<string, unknown>) => void;
  const result = withProgress(
    'fixture/echo',
    (text) => updates.push(text),
    (report) => {
      progress = report;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
  );
  t.mock.timers.tick(1999);
  assert.equal(updates.length, 0);
  t.mock.timers.tick(1);
  assert.match(updates[0], /fixture\/echo · awaiting result · 2s/);
  progress({ progress: 1, total: 2, message: '\x1b[31mReading\n' + 'x'.repeat(2000) });
  assert.match(updates.at(-1)!, /server progress: 1 \/ 2 — Reading/);
  assert.doesNotMatch(updates.at(-1)!, /\x1b|\n/);
  assert.ok(updates.at(-1)!.length < 400);
  finish(7);
  assert.equal(await result, 7);
  const count = updates.length;
  t.mock.timers.tick(6000);
  assert.equal(updates.length, count);
  await assert.rejects(
    withProgress(
      's/t',
      (text) => updates.push(text),
      async () => {
        throw new Error('failed');
      },
    ),
  );
  t.mock.timers.tick(6000);
  assert.equal(updates.length, count);
  t.mock.timers.reset();
});
