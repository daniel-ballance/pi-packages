import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
/** Exported only to let isolated tests supply their own agent directory. Normal Pi uses getAgentDir(). */
export declare function registerDurableSubagents(pi: ExtensionAPI, agentDirectory: () => string): void;
export default registerDurableSubagents;
