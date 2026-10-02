import type { Context } from "@earendil-works/chord";
import { type Conversation, type Harness, type TaskId, type TaskOutcome, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static } from "@durable-subagents/typebox";
export declare const WorkflowSchema: Type.TObject<{
    version: Type.TLiteral<1>;
    name: Type.TString;
    limits: Type.TObject<{
        concurrency: Type.TInteger;
        maxAttempts: Type.TInteger;
    }>;
    steps: Type.TArray<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"task">;
        agent: Type.TString;
        instructions: Type.TString;
        id: Type.TString;
        dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"approval">;
        instructions: Type.TString;
        id: Type.TString;
        dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
    }>]>>;
}>;
export type WorkflowDefinition = Static<typeof WorkflowSchema>;
export type WorkflowStep = WorkflowDefinition["steps"][number];
/** Deliberately small native DSL; legacy loops/checks/artifacts/peers are rejected, never ignored. */
export declare function parseWorkflow(value: unknown): WorkflowDefinition;
export type WorkflowDeliveryResult = {
    status: "completed" | "failed" | "aborted";
    output?: string;
    reason?: string;
};
export type WorkflowSendRequest = {
    agent: string;
    message: string;
    operationId: string;
    /** MUST run inside the same transaction as new delivery admission, after idempotency lookup. */
    guard: (tx: Tx) => Promise<void>;
};
/**
 * Adapter over a native subagents service, not an RPC executor. send MUST deduplicate operationId,
 * revalidate agent policy/holds, and run request.guard atomically with new admission. It returns a
 * native delivery TaskId from the SAME Harness. Native task joins/read receipts supply wait/read.
 * assertCanDispatch is a preflight convenience; send's atomic checks are the authority.
 */
export interface WorkflowAdapter {
    assertCanDispatch(agent: string, context: Context): Promise<void>;
    send(request: WorkflowSendRequest, context: Context): Promise<{
        taskId: TaskId<WorkflowDeliveryResult>;
    }>;
}
export type WorkflowHost = Pick<Conversation, "id" | "commit">;
export type WorkflowReader = Pick<Harness, "getTask" | "snapshot">;
type Nodes = Record<string, TaskId<WorkflowNodeResult>[]>;
export type WorkflowResult = {
    nodes: Nodes;
};
export type WorkflowNodeResult = {
    output: string;
    deliveryTaskId?: TaskId<WorkflowDeliveryResult>;
};
type WorkflowInput = {
    definition: WorkflowDefinition;
    operationId: string;
};
type WorkflowCheckpoint = {
    phase: "dispatch";
    nodes: Nodes;
} | {
    phase: "collect";
    nodes: Nodes;
    batch: TaskId<WorkflowNodeResult>[];
} | {
    phase: "control";
    nodes: Nodes;
    revision: number;
};
type NodeInput = {
    workflowId: TaskId<WorkflowResult>;
    step: WorkflowStep;
    attempt: number;
    dependencies: TaskId<WorkflowNodeResult>[];
};
type NodeCheckpoint = {
    phase: "send";
} | {
    phase: "collect";
    deliveryTaskId: TaskId<WorkflowDeliveryResult>;
};
export type WorkflowControlState = {
    held: boolean;
    resumeRequired: boolean;
    revision: number;
    reason: string;
    approvals: Record<string, boolean>;
    retries: Record<string, number>;
};
/** Application intent only. Native task records remain the execution/outcome source of truth. */
export declare const WorkflowControl: import("@earendil-works/pi-durable").TaskDocToken<WorkflowControlState>;
/** Install every returned task definition in one registry before starting or reopening workflows. */
export declare function createWorkflowTask(adapter: WorkflowAdapter): {
    Workflow: import("@earendil-works/pi-durable").Task<WorkflowInput, WorkflowCheckpoint, WorkflowResult, object>;
    Node: import("@earendil-works/pi-durable").Task<NodeInput, NodeCheckpoint, WorkflowNodeResult, object>;
    tasks: (import("@earendil-works/pi-durable").Task<NodeInput, NodeCheckpoint, WorkflowNodeResult, object> | import("@earendil-works/pi-durable").Task<WorkflowInput, WorkflowCheckpoint, WorkflowResult, object>)[];
    /** Admission is idempotent per operationId and exact validated definition. Does not enable scheduling. */
    startWorkflow: (host: WorkflowHost, value: unknown, operationId: string, context: Context) => Promise<TaskId<WorkflowResult>>;
    /** Dispatch barrier only: already admitted deliveries may finish. */
    holdWorkflow: (host: WorkflowHost, taskId: TaskId<WorkflowResult>, context: Context) => Promise<void>;
    /** Clears the hold, but retains resumeRequired. No work starts from release alone. */
    releaseWorkflow: (host: WorkflowHost, taskId: TaskId<WorkflowResult>, context: Context) => Promise<void>;
    resumeWorkflow: (host: WorkflowHost, taskId: TaskId<WorkflowResult>, context: Context) => Promise<void>;
    approveWorkflow: (host: WorkflowHost, taskId: TaskId<WorkflowResult>, nodeId: string, context: Context) => Promise<void>;
    /** Grants one new attempt for an explicitly named failed node; successful dependencies stay untouched. */
    retryWorkflow: (host: WorkflowHost, taskId: TaskId<WorkflowResult>, nodeId: string, context: Context) => Promise<void>;
    inspectWorkflow: (reader: WorkflowReader, taskId: TaskId<WorkflowResult>, context: Context) => Promise<{
        taskId: TaskId<WorkflowResult>;
        status: "pending" | "running" | "waiting" | "completing" | "terminal";
        control: Readonly<WorkflowControlState> | undefined;
        nodeAttempts: Record<string, {
            taskId: TaskId<WorkflowNodeResult>;
            status: string;
            outcome?: TaskOutcome<WorkflowNodeResult>;
        }[]>;
        outcome: TaskOutcome<WorkflowResult> | undefined;
        phase: "dispatch" | "collect" | "control" | undefined;
    }>;
};
export {};
