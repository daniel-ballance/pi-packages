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

export function allows(limit: ChildLimit, total: number): boolean {
  switch (limit.kind) {
    case "off": return false;
    case "capped": return total <= limit.max;
    case "unlimited": return true;
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function permanentRefusal(limit: ChildLimit, count: number): string | undefined {
  switch (limit.kind) {
    case "off":
      return "Spawning is disabled by policy.";
    case "capped":
      return count <= limit.max ? undefined : `Live-child limit (${reportedLimit(limit)}) cannot fit ${count} children.`;
    case "unlimited":
      return undefined;
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function capacityOf(limit: ChildLimit, live: number, reserved: number): Capacity {
  const reported = reportedLimit(limit);
  switch (limit.kind) {
    case "off":
      return { limit: reported, live, reserved, available: 0 };
    case "capped":
      return { limit: reported, live, reserved, available: Math.max(0, limit.max - live - reserved) };
    case "unlimited":
      return { limit: reported, live, reserved, available: Number.MAX_SAFE_INTEGER };
    default: {
      const _exhaustive: never = limit;
      throw new Error(`Unhandled child limit: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function capacityReachedText(capacity: Pick<Capacity, "limit" | "live">, audience: "manager" | "root" | "nested"): string {
  const { limit, live } = capacity;
  if (audience === "manager") return `Live-child limit (${limit}) reached across the whole tree (${live} live); close an idle child first.`;
  const reached = `Live-child capacity reached (limit ${limit}). Inspect before closing idle workers; held work requires discussion.`;
  if (audience === "root") return reached;
  return `${reached} The limit of ${limit} counts every live child in the whole tree (${live} live). You can close only your own idle children. If you have none to reuse or close, do not retry. If you have a way to message your parent, ask it for a slot. Otherwise report the limit in your final reply.`;
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
