import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';
import { openSqliteSubagents } from '../src/sqlite.js';
import type { HostOptions } from '../src/runtime.js';
import type { DurablePolicy } from '../src/policy.js';
export const model = { provider: 'faux', model: 'faux-1', thinking: 'off' as const };
export async function setup(overrides: Partial<Omit<HostOptions, 'storage' | 'models' | 'baseDirectory' | 'policy'>> = {}, policyChanges: Partial<DurablePolicy> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-subagents-test-'));
  const path = join(directory, 'session.sqlite');
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  const policy: DurablePolicy = { allowedModels: [model], allowedTools: [], allowedRoots: [directory], maxAgents: 8, maxActiveAssignments: 16, maxPeerMessages: 3, ...policyChanges };
  const options = { models, policy, baseDirectory: directory, ...overrides };
  const open = (changes: Partial<typeof options> = {}) => openSqliteSubagents(path, { ...options, ...changes });
  const host = await open();
  return { directory, path, options, host, faux, models, policy, open,
    spawn: (name: string, tools: string[] = []) => host.spawn({ name, cwd: directory, model, tools, operationId: `spawn:${name}` }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
export function unanswered() {
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const step: FauxResponseStep = (_request, options) => new Promise((_resolve, reject) => {
    entered();
    const signal = options!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { step, reached };
}
export async function until(check: () => Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 5)); }
}
export const answer = (text: string) => fauxAssistantMessage(text);
