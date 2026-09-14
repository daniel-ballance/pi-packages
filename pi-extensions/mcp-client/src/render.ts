import { stripVTControlCharacters } from 'node:util';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

type Schema = Record<string, any>;
const secretName =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|private[-_]?key/i;

function plain(value: string, limit: number): string {
  const text = stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(id|uri|url|api|json)\b/gi, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function preview(value: unknown, schema: Schema | undefined, limit: number, depth = 0): unknown {
  if (schema?.writeOnly === true || schema?.format === 'password') return '[redacted]';
  if (typeof value === 'string') return plain(value, limit);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 2) return Array.isArray(value) ? `[${value.length} items]` : '[object]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => preview(item, schema?.items, limit, depth + 1));
    if (value.length > 4) items.push(`… ${value.length - 4} more`);
    return items;
  }
  const entries = Object.entries(value);
  const result = Object.fromEntries(
    entries
      .slice(0, 4)
      .map(([key, item]) => [
        plain(key, 64),
        secretName.test(key)
          ? '[redacted]'
          : preview(item, schema?.properties?.[key], limit, depth + 1),
      ]),
  );
  if (entries.length > 4) result['…'] = `${entries.length - 4} more`;
  return result;
}

/** Display-only: keep wire names, arguments and Pi's default result renderer untouched. */
export function renderMcpCall(
  server: string,
  tool: { name: string; title?: string; inputSchema?: Schema; annotations?: Schema },
): NonNullable<ToolDefinition['renderCall']> {
  const suppliedTitle = tool.title ?? tool.annotations?.title;
  const title =
    typeof suppliedTitle === 'string' && suppliedTitle.trim() ? suppliedTitle : humanize(tool.name);
  const heading = `${plain(humanize(server), 80)} · ${plain(title, 120)}`;
  return (args, theme, context) => {
    const lines = [theme.fg('toolTitle', theme.bold(heading))];
    const entries =
      args && typeof args === 'object' && !Array.isArray(args)
        ? Object.entries(args).filter(([, value]) => value !== undefined)
        : [];
    const count = context.expanded ? 16 : 4;
    const limit = context.expanded ? 800 : 180;
    for (const [key, value] of entries.slice(0, count)) {
      const schema = tool.inputSchema?.properties?.[key];
      const label = plain(typeof schema?.title === 'string' ? schema.title : humanize(key), 64);
      const formatted = secretName.test(key) ? '[redacted]' : preview(value, schema, limit);
      const text = plain(
        typeof formatted === 'string' ? formatted : (JSON.stringify(formatted) ?? ''),
        limit,
      );
      lines.push(`  ${theme.fg('muted', `${label}:`)} ${theme.fg('dim', text)}`);
    }
    if (entries.length > count)
      lines.push(theme.fg('dim', `  … ${entries.length - count} more arguments`));
    const component =
      context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
    component.setText(lines.join('\n'));
    return component;
  };
}
