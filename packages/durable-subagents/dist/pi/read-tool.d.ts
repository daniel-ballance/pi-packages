import { Type } from '@durable-subagents/pi-ai';
import type { DurableSubagents } from '../runtime.js';
/** A bounded readonly native tool. No ambient parent tool/extension inheritance. */
export declare function childRead(get: () => DurableSubagents): import("@earendil-works/pi-durable").ToolRegistration<Type.TObject<{
    path: Type.TString;
}>, import("@earendil-works/chord").JsonValue>;
