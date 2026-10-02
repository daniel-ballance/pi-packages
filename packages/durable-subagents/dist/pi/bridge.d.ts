import { type Models } from '@durable-subagents/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
/** No auth store, provider import, token resolution or ambient inference in this bridge.
 * Pi's registry owns every request and its request-time auth. */
export declare function bridgeModels(registry: ExtensionContext['modelRegistry']): Models;
