import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type, createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { openSqliteSubagents } from '../../src/sqlite.js';
const directory = process.argv[2]!;
const model = { provider: 'faux', model: 'faux-1', thinking: 'off' as const };
const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
const effect = defineTool({ name: 'effect', description: 'Crash fixture local effect', parameters: Type.Object({}), replay: 'unsafe',
  execute: async () => {
    appendFileSync(join(directory, 'effects.txt'), 'effect\n', { flush: true });
    // Intentionally bypass every close/cancel handler after effect, before its outcome commit.
    process.exit(73);
  },
});
const host = await openSqliteSubagents(join(directory, 'session.sqlite'), { models, baseDirectory: directory, tools: [effect], policy: {
  allowedModels: [model], allowedTools: ['effect'], allowedRoots: [directory], maxAgents: 2, maxActiveAssignments: 2, maxPeerMessages: 0,
} });
faux.setResponses([fauxAssistantMessage([fauxToolCall('effect', {})], { stopReason: 'toolUse' })]);
await host.spawn({ name: 'worker', cwd: directory, model, tools: ['effect'], operationId: 'spawn:worker' });
const sent = await host.send({ name: 'worker', message: 'crash effect', operationId: 'crash-work' });
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(sent), { flush: true });
await host.wait(sent.taskId);
throw new Error('Crash fixture unexpectedly completed');
