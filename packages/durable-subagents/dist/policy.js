import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
const POLICY_FIELDS = ["allowedModels", "allowedTools", "allowedRoots", "maxAgents", "maxActiveAssignments", "maxPeerMessages"];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MANAGEMENT_TOOLS = new Set(["spawn_agent", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]);
function object(value, label, fields) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error(`${label} must be a plain object`);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !fields.includes(key))
            throw new Error(`Unknown ${label} field: ${String(key)}`);
    }
    return value;
}
function exactString(value, label) {
    if (typeof value !== "string" || !value.length || value !== value.trim() || /[\0\r\n]/.test(value)) {
        throw new Error(`${label} must be an exact non-empty string`);
    }
    return value;
}
function strings(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    return Object.freeze([...new Set(value.map(item => exactString(item, label)))]);
}
function limit(value, label) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`${label} must be a non-negative safe integer`);
    return value;
}
function omitted(value, fallback) {
    return value === undefined ? fallback : value;
}
function modelKey(model) {
    return JSON.stringify([model.provider, model.model, model.thinking]);
}
/** Strings must include both the provider and thinking, e.g. acme/model:off. */
export function parseModel(value) {
    let input;
    if (typeof value === "string") {
        const slash = value.indexOf("/");
        const colon = value.lastIndexOf(":");
        if (slash < 1 || colon <= slash + 1 || colon === value.length - 1) {
            throw new Error("Model must be exact provider/model:thinking");
        }
        input = { provider: value.slice(0, slash), model: value.slice(slash + 1, colon), thinking: value.slice(colon + 1) };
    }
    else {
        input = object(value, "model", ["provider", "model", "thinking"]);
    }
    const provider = exactString(input.provider, "provider");
    const model = exactString(input.model, "model");
    const thinking = exactString(input.thinking, "thinking");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(provider) || /[\s*?\[\]]/.test(model)) {
        throw new Error("Model/provider must be exact identifiers without whitespace or wildcards");
    }
    if (!THINKING.has(thinking))
        throw new Error(`Unsupported Durable v1 thinking: ${thinking}`);
    return Object.freeze({ provider, model, thinking });
}
/** Reserved parent management names cannot be granted, even by an allowlist. */
export function isManagementTool(name) {
    return /^subagents?(?:$|[_./:-])/i.test(name) || MANAGEMENT_TOOLS.has(name.toLowerCase());
}
function checkTool(name, maxPeerMessages) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(name))
        throw new Error(`Tool must be an exact identifier: ${name}`);
    if (isManagementTool(name))
        throw new Error(`Nested subagent management tool is forbidden: ${name}`);
    if (name === "peer_send" && maxPeerMessages === 0)
        throw new Error("peer_send requires a positive maxPeerMessages limit");
}
/** Parsing never falls back to ambient policy; an empty object grants nothing. */
export function parsePolicy(value) {
    const input = object(value, "policy", POLICY_FIELDS);
    const choices = omitted(input.allowedModels, []);
    if (!Array.isArray(choices))
        throw new Error("allowedModels must be an array");
    const models = new Map();
    for (const choice of choices) {
        const model = parseModel(choice);
        models.set(modelKey(model), model);
    }
    const maxPeerMessages = limit(omitted(input.maxPeerMessages, 0), "maxPeerMessages");
    const allowedTools = strings(omitted(input.allowedTools, []), "allowedTools");
    for (const tool of allowedTools)
        checkTool(tool, maxPeerMessages);
    return Object.freeze({
        allowedModels: Object.freeze([...models.values()]),
        allowedTools,
        allowedRoots: strings(omitted(input.allowedRoots, []), "allowedRoots"),
        maxAgents: limit(omitted(input.maxAgents, 0), "maxAgents"),
        maxActiveAssignments: limit(omitted(input.maxActiveAssignments, 0), "maxActiveAssignments"),
        maxPeerMessages,
    });
}
function directory(value) {
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory())
        throw new Error(`Expected a directory: ${value}`);
    return canonical;
}
/** Resolve roots once against an explicit base, never process.cwd() or $HOME. */
export function compilePolicy(value, baseDirectory) {
    const policy = parsePolicy(value);
    if (!isAbsolute(exactString(baseDirectory, "baseDirectory")))
        throw new Error("baseDirectory must be absolute");
    const base = directory(baseDirectory);
    const allowedRoots = Object.freeze([...new Set(policy.allowedRoots.map(root => directory(resolve(base, root))))]);
    return Object.freeze({ ...policy, allowedRoots });
}
function isInside(root, cwd) {
    const remainder = relative(root, cwd);
    return !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}
/**
 * Call at child admission and on recovery before enabling execution. Pass only
 * this result's tools to the native child; do not inherit parent extensions.
 * Providers must be supplied by the host. Selection does not prove provider
 * availability, credential isolation, or the safety of host tool code.
 */
export function compileChildSelection(policy, value) {
    const input = object(value, "child selection", ["model", "tools", "cwd"]);
    const model = parseModel(input.model);
    if (!policy.allowedModels.some(allowed => modelKey(allowed) === modelKey(model)))
        throw new Error("Model/thinking selection is not allowed");
    const tools = strings(omitted(input.tools, []), "tools");
    for (const tool of tools) {
        checkTool(tool, policy.maxPeerMessages);
        if (!policy.allowedTools.includes(tool))
            throw new Error(`Tool is not allowed: ${tool}`);
    }
    const requestedCwd = exactString(input.cwd, "cwd");
    if (!isAbsolute(requestedCwd))
        throw new Error("cwd must be absolute");
    const cwd = directory(requestedCwd);
    if (!policy.allowedRoots.some(root => isAbsolute(root) && isInside(root, cwd)))
        throw new Error("cwd is outside allowedRoots");
    return Object.freeze({ model, tools, cwd });
}
