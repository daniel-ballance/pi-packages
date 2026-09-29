import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Peer } from './peer.js';
import { RpcError } from './peer.js';
import type { ObjectValue } from './headers.js';

export const TASKS = 'io.modelcontextprotocol/tasks';
export const TaskSchema = z
  .object({
    taskId: z.string().min(1).max(4096),
    status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().min(0).max(2147483647).optional(),
  })
  .passthrough();
export interface SavedTask {
  server: string;
  identity: string;
  taskId: string;
  tool: string;
  status: string;
  answered: string[];
  outputSchema?: ObjectValue;
}

/** Explicit, bounded waiting inside a Pi tool, not a background agent or call replay. */
export async function waitForTask(
  peer: Peer,
  task: SavedTask,
  signal: AbortSignal,
  persist: () => void,
  progress: (status: string) => void = () => {},
): Promise<ObjectValue> {
  for (let poll = 0; poll < 1000; poll++) {
    signal.throwIfAborted();
    const result = TaskSchema.parse(
      await peer.request('tasks/get', { taskId: task.taskId }, { signal }),
    );
    if (result.taskId !== task.taskId) throw new Error('Mismatched MCP task ID');
    if (task.status !== result.status) {
      task.status = result.status;
      persist();
    }
    progress(result.status);
    if (result.status === 'completed') {
      if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result))
        throw new Error('Invalid task result');
      return result.result as ObjectValue;
    }
    if (result.status === 'failed') {
      const error = result.error as ObjectValue | undefined;
      throw new RpcError(
        typeof error?.code === 'number' ? error.code : -32603,
        typeof error?.message === 'string' ? error.message : 'Task failed',
        error?.data,
      );
    }
    if (result.status === 'cancelled') throw new Error('MCP task cancelled');
    if (result.status === 'input_required') {
      const requests = result.inputRequests;
      if (
        !requests ||
        typeof requests !== 'object' ||
        Array.isArray(requests) ||
        Object.keys(requests).length > 32
      )
        throw new Error('Invalid task input requests');
      for (const [key, value] of Object.entries(requests)) {
        if (task.answered.includes(key)) continue;
        if (task.answered.length >= 256) throw new Error('Task input-request budget exceeded');
        const input = value as ObjectValue;
        const response = await peer.oninput?.(input.method, input.params ?? {}, signal);
        if (!response) throw new Error('Unsupported task input');
        // Persist before sending: uncertain delivery must not repeat paid sampling or dialogs.
        task.answered.push(key);
        persist();
        await peer.request(
          'tasks/update',
          { taskId: task.taskId, inputResponses: { [key]: response } },
          { signal },
        );
      }
    }
    await sleep(Math.max(100, result.pollIntervalMs ?? 1000), undefined, { signal });
  }
  throw new Error('Task polling budget exceeded; handle retained for explicit resume');
}
