declare const capBrand: unique symbol;

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

export const OMITTED_CHILD_LIMIT: ChildLimit = capped(4);

export interface Capacity {
  limit: number | "unlimited";
  live: number;
  reserved: number;
  available: number;
}

export function parseChildLimit(value: unknown): ChildLimit {
  if (value === undefined) return OMITTED_CHILD_LIMIT;
  if (value === 0) return { kind: "off" };
  if (value === -1) return { kind: "unlimited" };
  if (typeof value !== "number") throw new Error(INVALID_MAX_CHILDREN);
  return capped(value);
}

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

export function limitLabel(reported: unknown): string | undefined {
  if (reported === "unlimited") return "no child limit";
  if (typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0) return `max ${reported} children`;
  return undefined;
}
