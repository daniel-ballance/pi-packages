import { Type } from '@durable-subagents/pi-ai';
import { type ToolRegistration } from '@earendil-works/pi-durable';
import type { DurableSubagents } from './runtime.js';
export declare function createPeerTool(host: () => DurableSubagents): ToolRegistration<Type.TObject<{
    recipient: Type.TString;
    message: Type.TString;
    operationId: Type.TString;
}>, import("@earendil-works/chord").JsonValue>;
export declare function createParentTools(host: () => DurableSubagents): ToolRegistration[];
