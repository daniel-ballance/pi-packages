declare const capBrand: unique symbol;

/** A cap from 1 to Number.MAX_SAFE_INTEGER. Not exported, so only this module can make one. */
type Cap = number & { readonly [capBrand]: true };

export type ChildLimit =
  | { readonly kind: "off" }
  | { readonly kind: "capped"; readonly max: Cap }
  | { readonly kind: "unlimited" };

const INVALID_MAX_CHILDREN = "maxChildren must be a positive integer, 0 to disable spawning, or -1 for no limit";

function capped(max: number): ChildLimit {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error(INVALID_MAX_CHILDREN);
  return { kind: "capped", max: max as Cap };
}

/** An omitted maxChildren field. The built-in policy is 6, not 4. */
export const OMITTED_CHILD_LIMIT: ChildLimit = capped(4);

/** The limit as tool results report it. JSON-safe in every kind. */
export interface Capacity {
  /** A count, 0 when spawning is off, or "unlimited". Never -1. */
  limit: number | "unlimited";
  live: number;
  reserved: number;
  /**
   * How many more children allows would admit. Number.MAX_SAFE_INTEGER when there is no cap:
   * finite, so JSON keeps it, and truthy, so !available still means no room.
   */
  available: number;
}

/** Reads policy JSON maxChildren. The only code that knows the wire encoding. */
export function parseChildLimit(value: unknown): ChildLimit {
  if (value === undefined) return OMITTED_CHILD_LIMIT;
  if (value === 0) return { kind: "off" };
  if (value === -1) return { kind: "unlimited" };
  if (typeof value !== "number") throw new Error(INVALID_MAX_CHILDREN);
  return capped(value);
}

/** Whether `live` children may be live at once. Callers pass the total if this admission goes ahead. */
export function allows(limit: ChildLimit, live: number): boolean {
  switch (limit.kind) {
    case "off": return false;
    case "capped": return live <= limit.max;
    case "unlimited": return true;
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function capacityOf(limit: ChildLimit, live: number, reserved: number): Capacity {
  switch (limit.kind) {
    case "off":
      return { limit: 0, live, reserved, available: 0 };
    case "capped":
      return { limit: limit.max, live, reserved, available: Math.max(0, limit.max - live - reserved) };
    case "unlimited":
      return { limit: "unlimited", live, reserved, available: Number.MAX_SAFE_INTEGER };
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** The catalog's maxChildren. Same encoding as Capacity.limit. */
export function reportedLimit(limit: ChildLimit): Capacity["limit"] {
  switch (limit.kind) {
    case "off": return 0;
    case "capped": return limit.max;
    case "unlimited": return "unlimited";
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * TUI text for a reported limit. Takes unknown because render also draws details older versions persisted.
 * Returns undefined for any value reportedLimit cannot produce, so a bad value draws no label.
 */
export function limitLabel(reported: unknown): string | undefined {
  if (reported === "unlimited") return "no child limit";
  if (typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0) return `max ${reported} children`;
  return undefined;
}
