import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { openSqliteSubagents } from './sqlite.js';

const command = process.argv[2] ?? '--help';
if (command === '--help' || command === '-h') {
  console.log('Native Pi Durable subagents (experimental)\n\nUsage: node --import tsx src/cli.ts smoke\n\nsmoke: boot SQLite + native harness, run a local scripted collaborator, reopen and verify persistence.\nNo credentials, network model provider or inference charges. Live providers are injected by a host application.');
} else if (command === 'smoke') {
  const directory = await mkdtemp(join(tmpdir(), 'durable-subagents-smoke-'));
  const path = join(directory, 'session.sqlite');
  const model = { provider: 'faux', model: 'faux-1', thinking: 'off' as const };
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('native durable smoke passed')]);
  const options = { models, baseDirectory: directory, policy: {
    allowedModels: [model], allowedTools: [], allowedRoots: [directory], maxAgents: 1, maxActiveAssignments: 1, maxPeerMessages: 0,
  } };
  let host = await openSqliteSubagents(path, options);
  try {
    const child = await host.spawn({ name: 'smoke', cwd: directory, model, operationId: 'spawn:smoke' });
    const work = await host.send({ name: 'smoke', message: 'Provider-free boot smoke', operationId: 'smoke:1' });
    const result = await host.wait(work.taskId);
    if (result.output !== 'native durable smoke passed') throw new Error(`Unexpected smoke result: ${JSON.stringify(result)}`);
    await host.close(); host = await openSqliteSubagents(path, options);
    if ((await host.child('smoke')).conversationId !== child.conversationId) throw new Error('Conversation identity changed on reopen');
    if ((await host.readReports()).reports.length !== 1) throw new Error('Durable report was not retained exactly once');
    console.log(JSON.stringify({ ok: true, runtime: '@earendil-works/pi-durable@1.0.0', provider: 'local faux (no network)', sqliteReopen: true, result: result.output }, null, 2));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
} else {
  console.error(`Unknown command: ${command}`); process.exitCode = 2;
}
