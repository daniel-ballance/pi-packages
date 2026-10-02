import type { Context } from '@earendil-works/chord';
import { type Models } from '@durable-subagents/pi-ai/models';
import { Harness, type Conversation, type ConversationId, type HarnessOptions, type Storage, type Tx, type TaskId, type ToolRegistration } from '@earendil-works/pi-durable';
import { type CompiledDurablePolicy, type DurablePolicy, type DurableModelSelection } from './policy.js';
import { type Child, type TeamState } from './state.js';
import { createWorkflowTask } from './workflows.js';
export type DeliveryResult = {
    status: 'completed' | 'failed' | 'aborted';
    output?: string;
    answer?: number;
    reason?: string;
};
export type DeliveryInput = {
    name: string;
    message: string;
    operationId: string;
    mode: 'steer' | 'followUp';
    peerFrom?: string;
};
export type SpawnRequest = {
    name: string;
    model: DurableModelSelection;
    cwd: string;
    tools?: string[];
    operationId: string;
};
export type HostOptions = {
    storage: Storage;
    models: Models;
    policy: DurablePolicy;
    baseDirectory: string;
    /** Trusted host implementations only. No stable-Pi extension discovery or credentials are imported. */
    tools?: readonly ToolRegistration[];
    env?: HarnessOptions['env'];
    onReport?: (error: unknown) => void;
};
/** Standalone native Durable host. The root is the trusted parent; child tools cannot release human holds. */
export declare class DurableSubagents {
    readonly harness: Harness;
    readonly root: Conversation;
    readonly policy: CompiledDurablePolicy;
    private readonly models;
    private readonly toolMap;
    private readonly childExtension;
    private readonly delivery;
    private readonly fence;
    readonly workflows: ReturnType<typeof createWorkflowTask>;
    private readonly cancellations;
    private constructor();
    static open(options: HostOptions): Promise<DurableSubagents>;
    state(context?: Context): Promise<Readonly<TeamState>>;
    child(name: string, context?: Context): Promise<Child>;
    assertAvailable(name: string, context?: Context): Promise<Child>;
    private validateSelection;
    assertToolAllowed(conversationId: ConversationId, tool: string, context?: Context): Promise<Child>;
    private tasks;
    private prepareRecovery;
    spawn(request: SpawnRequest, context?: Context): Promise<Child>;
    send(input: {
        name: string;
        message: string;
        operationId: string;
        mode?: 'steer' | 'followUp';
        guard?: (tx: Tx) => Promise<void>;
    }, context?: Context): Promise<{
        operationId: string;
        taskId: TaskId<DeliveryResult>;
    }>;
    private enqueue;
    /** Called only by a native child tool; caller identity comes from execution context, never tool arguments. */
    peerSend(caller: ConversationId, input: {
        recipient: string;
        message: string;
        operationId: string;
    }, context?: Context): Promise<{
        operationId: string;
        taskId: TaskId<DeliveryResult>;
    }>;
    connect(a: string, b: string, limit: number, context?: Context): Promise<void>;
    disconnect(a: string, b: string, context?: Context): Promise<void>;
    renew(from: string, to: string, allowance: number, operationId: string, context?: Context): Promise<void>;
    /** Human-only supervision. The durable hold commits before cooperative cancellation starts. */
    halt(name: string, operationId: string, reason?: string, context?: Context): Promise<Child>;
    private cancelHeld;
    private drainHeld;
    release(name: string, context?: Context): Promise<void>;
    wait(taskId: TaskId<DeliveryResult>, context?: Context): Promise<DeliveryResult>;
    list(context?: Context): Promise<{
        agents: {
            status: string;
            usage: Readonly<import("@earendil-works/pi-durable").UsageState> | null;
            name: string;
            conversationId: ConversationId;
            model: {
                provider: string;
                model: string;
                thinking: DurableModelSelection["thinking"];
            };
            tools: string[];
            cwd: string;
            hold?: {
                operationId: string;
                reason: string;
                requestedAt: number;
                confirmed: boolean;
            };
        }[];
        peers: Record<string, import("./state.js").PeerEdge>;
        unreadReports: number;
    }>;
    readReports(options?: {
        after?: number;
        limit?: number;
        acknowledge?: boolean;
    }, context?: Context): Promise<{
        reports: {
            sequence: number;
            name: string;
            kind: "result" | "intervention";
            text: string;
            taskId?: TaskId | undefined;
            answer?: import("@earendil-works/pi-durable").EntryId | undefined;
        }[];
        gap: boolean;
        next: number;
    }>;
    /** Stable parent history has observed this contiguous report prefix. Never acknowledge enqueue alone. */
    acknowledgeReports(through: number, context?: Context): Promise<void>;
    close(context?: Context): Promise<void>;
    deliver(input: DeliveryInput, taskId: TaskId, context: Context): Promise<import("@earendil-works/pi-durable").Submission>;
}
