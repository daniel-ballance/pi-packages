import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Type, createModels, fauxProvider, fauxAssistantMessage } from '@durable-subagents/pi-ai';
import { defineTool, type TaskId } from '@earendil-works/pi-durable';
import { openSqliteSubagents } from '../src/sqlite.js';
import type { DeliveryResult } from '../src/runtime.js';

for (const revocation of ['none', 'tool', 'model', 'root'] as const) {
  test(`abrupt safe-tool process exit: ${revocation === 'none' ? 'replays once' : `${revocation} revocation vetoes replay`}`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-safe-crash-'));
    const fixture = fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, directory, 'safe'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' });
    let errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 73, errors);
      assert.equal(await readFile(join(directory, 'effects.txt'), 'utf8'), 'effect\n');
      const model = { provider: 'faux', model: 'faux-1', thinking: 'off' as const };
      const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
      let replayed = 0, requests = 0;
      faux.setResponses([() => { requests++; return fauxAssistantMessage('recovered'); }]);
      const effect = defineTool({ name: 'effect', description: 'Disposable recovery effect', parameters: Type.Object({}), replay: 'safe',
        execute: async () => { replayed++; return { content: [{ type: 'text', text: 'replayed safely' }] }; },
      });
      const alternateRoot = join(directory, 'new-allowed-root'); await mkdir(alternateRoot);
      const options = { models, tools: [effect], baseDirectory: directory, policy: {
        allowedModels: revocation === 'model' ? [] : [model], allowedTools: revocation === 'tool' ? [] : ['effect'],
        allowedRoots: [revocation === 'root' ? alternateRoot : directory], maxAgents: 2, maxActiveAssignments: 2, maxPeerMessages: 0,
      } };
      const path = join(directory, 'session.sqlite');
      await assert.rejects(() => openSqliteSubagents(path, options), /stale lock/);
      // Only this disposable process owned the database, and its exit was observed.
      await rm(`${path}.lock`, { recursive: true });
      const host = await openSqliteSubagents(path, options);
      try {
        const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as { taskId: TaskId<DeliveryResult> };
        const result = await host.wait(receipt.taskId);
        assert.equal(replayed, revocation === 'none' ? 1 : 0);
        assert.equal(requests, revocation === 'none' ? 1 : 0);
        if (revocation === 'none') {
          assert.equal(result.status, 'completed');
          assert.equal(result.output, 'recovered');
          assert.equal((await host.readReports()).reports.length, 1);
        } else {
          assert.equal(result.status, 'aborted');
          assert.equal((await host.child('worker')).hold?.confirmed, true);
          await host.release('worker');
          await assert.rejects(() => host.send({ name: 'worker', message: 'must stay revoked', operationId: 'revoked-again' }), /not allowed|outside allowedRoots/);
          assert.equal(replayed, 0); assert.equal(requests, 0);
        }
        assert.equal(await readFile(join(directory, 'effects.txt'), 'utf8'), 'effect\n');
      } finally { await host.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
}
