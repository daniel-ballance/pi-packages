/** Explicit Durable v1 choices, not aliases resolved from a Pi settings file. */
export type DurableThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface DurableModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly thinking: DurableThinking;
}
export type DurableModelChoice = string | DurableModelSelection;
/**
 * A deliberately small, deny-by-default policy. This is not the stable Pi
 * subagents.json format. No settings, credentials, extensions, MCP servers,
 * context files, or provider catalogs are discovered or imported here.
 *
 * The host supplies providers and tool implementations explicitly and must
 * enforce the limits when it admits work. A cwd check limits composition; it
 * does not sandbox a provider or an arbitrary tool implementation.
 */
export interface DurablePolicy {
    readonly allowedModels: readonly DurableModelChoice[];
    readonly allowedTools: readonly string[];
    readonly allowedRoots: readonly string[];
    readonly maxAgents: number;
    readonly maxActiveAssignments: number;
    readonly maxPeerMessages: number;
}
export interface CompiledDurablePolicy extends Omit<DurablePolicy, "allowedModels"> {
    readonly allowedModels: readonly DurableModelSelection[];
}
export interface ChildSelection {
    readonly model: DurableModelChoice;
    /** Omitted tools means no tools, never all allowed tools. */
    readonly tools?: readonly string[];
    readonly cwd: string;
}
export interface CompiledChildSelection {
    readonly model: DurableModelSelection;
    readonly tools: readonly string[];
    readonly cwd: string;
}
/** Strings must include both the provider and thinking, e.g. acme/model:off. */
export declare function parseModel(value: unknown): DurableModelSelection;
/** Reserved parent management names cannot be granted, even by an allowlist. */
export declare function isManagementTool(name: string): boolean;
/** Parsing never falls back to ambient policy; an empty object grants nothing. */
export declare function parsePolicy(value: unknown): CompiledDurablePolicy;
/** Resolve roots once against an explicit base, never process.cwd() or $HOME. */
export declare function compilePolicy(value: unknown, baseDirectory: string): CompiledDurablePolicy;
/**
 * Call at child admission and on recovery before enabling execution. Pass only
 * this result's tools to the native child; do not inherit parent extensions.
 * Providers must be supplied by the host. Selection does not prove provider
 * availability, credential isolation, or the safety of host tool code.
 */
export declare function compileChildSelection(policy: CompiledDurablePolicy, value: ChildSelection): CompiledChildSelection;
