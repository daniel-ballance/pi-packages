import { type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import type { DurableModelSelection } from './policy.js';
export type Child = {
    name: string;
    conversationId: ConversationId;
    model: {
        provider: string;
        model: string;
        thinking: DurableModelSelection['thinking'];
    };
    tools: string[];
    cwd: string;
    hold?: {
        operationId: string;
        reason: string;
        requestedAt: number;
        confirmed: boolean;
    };
};
export type PeerEdge = {
    enabled: boolean;
    limit: number;
    used: number;
    generation: number;
};
export type Report = {
    sequence: number;
    name: string;
    kind: 'result' | 'intervention';
    text: string;
    taskId?: TaskId;
    answer?: EntryId;
};
export type TeamState = {
    agents: Record<string, Child>;
    peers: Record<string, PeerEdge>;
    reports: Report[];
    nextSequence: number;
    readThrough: number;
};
export declare const TeamDoc: import("@earendil-works/pi-durable").ConversationDocToken<TeamState>;
export declare const OperationDoc: import("@earendil-works/pi-durable").ConversationDocFamilyToken<{
    fingerprint: string;
    taskId?: TaskId;
    conversationId?: ConversationId;
    done?: boolean;
}, string>;
export declare const ReportedAnswerDoc: import("@earendil-works/pi-durable").ConversationDocFamilyToken<{
    reported: boolean;
}, null>;
export declare function appendReport(state: TeamState, report: Omit<Report, 'sequence'>): Report;
export declare function checkedName(name: string): string;
export declare function checkedOperationId(id: string): string;
