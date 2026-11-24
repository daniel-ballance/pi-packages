import { resolve, sep } from "node:path";

/** Only skill/playbook opens form the route. Keep ranges: an open is not proof of a full read. */
export function readSequence(fixture, skillsRoots, limit) {
  const roots = [skillsRoots].flat();
  const reads = [], byId = new Map();
  const routing = () => reads.filter(r => /(?:^|\/)(?:SKILL\.md|playbooks\/[^/]+\.md)$/.test(r.path));
  let position = 0;
  return {
    reads,
    record(event) {
      if (event.toolName !== "read") return false;
      position++;
      if (event.type === "tool_execution_start") {
        const absolute = resolve(fixture, event.args.path), prefix = roots.map(root => root + sep).find(root => absolute.startsWith(root));
        const read = { path: prefix ? absolute.slice(prefix.length) : absolute, start: position, offset: event.args.offset, limit: event.args.limit };
        reads.push(read);
        byId.set(event.toolCallId, read);
      } else if (event.type === "tool_execution_end") {
        const read = byId.get(event.toolCallId);
        if (!read) throw new Error("Invalid JSONL: read end without start");
        read.ok = event.isError === false && !event.result?.isError;
        read.end = position;
        return (routing().length >= limit || reads.length >= limit + 4) && reads.every(r => r.end !== undefined);
      }
      return false;
    },
    observed: () => routing().map(r => r.path),
    // Start order decides: a row's reads issued as one batch overlap and still count.
    // `none` grades a prompt that should open no skill or playbook at all.
    matches(expected, absent = [], none = false) {
      const route = routing();
      if (none) return expected.length === 0 && route.length === 0;
      return expected.length > 0 && expected.every((path, i) => route[i]?.ok && route[i].path === path)
        && !route.some(r => absent.includes(r.path));
    },
  };
}
