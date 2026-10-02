import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Type, createModels, fauxProvider, fauxAssistantMessage } from '@durable-subagents/pi-ai';
import { defineTool, type TaskId } from '@earendil-works/pi-durable';
import { openSqliteSubagents } from '../src/sqlite.js';
import type { DeliveryResult } from '../src/runtime.js';

test('abrupt process exit after unsafe effect recovers native intent without repeating effect', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-subagents-crash-'));
  const fixture = fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, directory], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' });
    let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 73, errors);
    assert.equal(await readFile(join(directory, 'effects.txt'), 'utf8'), 'effect\n');
    const model = { provider: 'faux', model: 'faux-1', thinking: 'off' as const };
    const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage('interrupted tool reviewed')]);
    let replayed = 0;
    const effect = defineTool({ name: 'effect', description: 'Must not replay', parameters: Type.Object({}), replay: 'unsafe',
      execute: async () => { replayed++; return { content: [{ type: 'text', text: 'wrong replay' }] }; },
    });
    const options = { models, tools: [effect], baseDirectory: directory, policy: { allowedModels: [model], allowedTools: ['effect'], allowedRoots: [directory], maxAgents: 2, maxActiveAssignments: 2, maxPeerMessages: 0 } };
    const path = join(directory, 'session.sqlite');
    await assert.rejects(() => openSqliteSubagents(path, options), /stale lock/);
    // Test controls this child and has observed its exit. Emulate the documented operator recovery step.
    await rm(`${path}.lock`, { recursive: true });
    const host = await openSqliteSubagents(path, options);
    try {
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as { taskId: TaskId<DeliveryResult> };
      await host.wait(receipt.taskId);
      assert.equal(replayed, 0);
      assert.equal(await readFile(join(directory, 'effects.txt'), 'utf8'), 'effect\n');
    } finally { await host.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
