import { defineDoc, defineDocFamily, type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import type { DurableModelSelection } from './policy.js';

export type Child = {
  name: string;
  conversationId: ConversationId;
  model: { provider: string; model: string; thinking: DurableModelSelection['thinking'] };
  tools: string[];
  cwd: string;
  hold?: { operationId: string; reason: string; requestedAt: number; confirmed: boolean };
};
export type PeerEdge = { enabled: boolean; limit: number; used: number; generation: number };
export type Report = {
  sequence: number; name: string; kind: 'result' | 'intervention'; text: string;
  taskId?: TaskId; answer?: EntryId;
};
export type TeamState = {
  agents: Record<string, Child>;
  peers: Record<string, PeerEdge>;
  reports: Report[];
  nextSequence: number;
  readThrough: number;
};
export const TeamDoc = defineDoc<TeamState>({
  kind: 'pi-packages.subagents.team', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ agents: {}, peers: {}, reports: [], nextSequence: 1, readThrough: 0 }),
});
// One record per logical operation avoids an ever-growing central operation map.
// These keys are retained: evicting them would silently weaken replay deduplication.
export const OperationDoc = defineDocFamily<{ fingerprint: string; taskId?: TaskId; conversationId?: ConversationId; done?: boolean }, string>({
  family: true, kind: 'pi-packages.subagents.operation', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (fingerprint) => ({ fingerprint }),
});
export const ReportedAnswerDoc = defineDocFamily<{ reported: boolean }, null>({
  family: true, kind: 'pi-packages.subagents.reported-answer', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ reported: false }),
});
export function appendReport(state: TeamState, report: Omit<Report, 'sequence'>): Report {
  const item = { ...report, sequence: state.nextSequence++ };
  state.reports.push(item);
  if (state.reports.length > 200) state.reports.splice(0, state.reports.length - 200);
  return item;
}
export function checkedName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name))
    throw new Error('Agent names must be 1–64 simple letters/digits/_/- starting with a letter');
  return name;
}
export function checkedOperationId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(id)) throw new Error('Provide a stable operationId (1–160 simple characters)');
  return id;
}
