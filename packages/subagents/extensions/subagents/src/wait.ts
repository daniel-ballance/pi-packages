/** Why a wait returned, in precedence order: the first that holds wins.
 *  Abort is not a reason. The wait throws, and the tool call ends aborted. */
export const WAKE_REASONS = ["hold", "input", "settled", "message", "timeout"] as const;
export type WakeReason = typeof WAKE_REASONS[number];
export const isWakeReason = (value: unknown): value is WakeReason =>
  (WAKE_REASONS as readonly unknown[]).includes(value);

/** Which children a wait watched, and why it stopped. */
export interface WaitEnd { readonly wake: WakeReason; readonly ids: readonly string[] }
