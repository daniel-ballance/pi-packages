export type ObjectValue = Record<string, any>;
export interface HeaderBinding {
  name: string;
  path: string[];
  type: string;
}
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e\t]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith('=?base64?') && value.endsWith('?='))
    ? value
    : `=?base64?${Buffer.from(value).toString('base64')}?=`;
}
export function headerBindings(schema: ObjectValue): HeaderBinding[] {
  const bindings: HeaderBinding[] = [];
  const names = new Set<string>();
  function walk(node: any, path: string[], reachable: boolean) {
    if (!node || typeof node !== 'object') return;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      if (
        !reachable ||
        !path.length ||
        typeof name !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        !['string', 'integer', 'boolean'].includes(node.type) ||
        names.has(name.toLowerCase())
      )
        throw new Error('Invalid or duplicate x-mcp-header annotation');
      names.add(name.toLowerCase());
      bindings.push({ name, path, type: node.type });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [property, child] of Object.entries(value))
          walk(child, [...path, property], reachable);
      } else if (key !== 'x-mcp-header') walk(value, path, false);
    }
  }
  walk(schema, [], true);
  return bindings;
}
export function parameterHeaders(
  bindings: HeaderBinding[],
  args: ObjectValue,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const binding of bindings) {
    let value: any = args;
    for (const key of binding.path)
      value =
        value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
    if (value == null) continue;
    if (binding.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== binding.type)
      throw new Error(`Invalid mirrored parameter: ${binding.path.join('.')}`);
    headers[`Mcp-Param-${binding.name}`] = encodeHeader(String(value));
  }
  return headers;
}
