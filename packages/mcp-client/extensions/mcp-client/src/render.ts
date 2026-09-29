import { stripVTControlCharacters } from 'node:util';
import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

type Schema = Record<string, any>;
type Render = NonNullable<ToolDefinition['renderCall']>;
type CallContext = { lastComponent?: unknown; expanded?: boolean; argsComplete?: boolean };
const secretName =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|private[-_]?key/i;
const qualifierName = /^(limit|timeout|timeoutseconds)$/i;
const protectedSchema = (shape?: Schema) =>
  shape &&
  typeof shape === 'object' &&
  (shape.writeOnly === true ||
    shape.format === 'password' ||
    ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'patternProperties'].some((key) => key in shape));

function plain(value: string, limit: number): string {
  const text = stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Display words only. Wire names stay unchanged. */
function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function actionName(name: string): string {
  const text = words(name);
  return text.startsWith('browser ') ? text.slice('browser '.length) || text : text;
}

function thingName(server: string): string {
  return plain(server, 80).toLowerCase();
}

function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function command(theme: Theme, action: string, thing?: string): string {
  return theme.fg('toolTitle', theme.bold(thing ? `${thing} • ${action}` : action));
}

function paint(
  theme: Theme,
  action: string,
  thing: string | undefined,
  parts: {
    accent?: string;
    output?: string[];
    muted?: string[];
    invalid?: boolean;
    pending?: boolean;
  },
): string {
  let text = command(theme, action, thing);
  if (parts.invalid) return `${text} ${theme.fg('error', '[invalid arg]')}`;
  if (parts.pending) text += ` ${theme.fg('toolOutput', '...')}`;
  if (parts.accent) text += ` ${theme.fg('accent', parts.accent)}`;
  for (const part of parts.output ?? []) text += ` ${theme.fg('toolOutput', part)}`;
  for (const part of parts.muted ?? []) text += theme.fg('muted', ` (${part})`);
  return text;
}

function textLine(context: CallContext, value: string) {
  const component =
    context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
  component.setText(value);
  return component;
}

function stringArg(
  value: unknown,
  limit: number,
  complete: boolean,
): { text?: string; invalid?: boolean; pending?: boolean } {
  if (typeof value === 'string') {
    const text = plain(value, limit);
    return text ? { text } : complete ? {} : { pending: true };
  }
  if (value == null) return complete ? {} : { pending: true };
  return { invalid: true };
}

function preview(
  key: string,
  value: unknown,
  schema: Schema | undefined,
  limit: number,
): string | undefined {
  if (value === undefined || value === false || value === null || value === '') return undefined;
  if (protectedSchema(schema)) return '[schema-protected]';
  if (schema?.writeOnly === true || schema?.format === 'password' || secretName.test(key))
    return '[redacted]';
  if (typeof value === 'string') return plain(value, limit) || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === true) return words(key);
  if (Array.isArray(value)) {
    if (protectedSchema(schema?.items) || schema?.prefixItems?.some(protectedSchema))
      return '[schema-protected]';
    if (value.length === 0) return undefined;
    const strings = value.every((item) => typeof item === 'string')
      ? value.map((item) => plain(String(item), 40)).filter(Boolean)
      : [];
    if (strings.length === value.length && strings.join(' ').length <= limit)
      return strings.slice(0, 4).join(' ');
    return `${value.length} ${words(key)}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.some(([child]) => secretName.test(child))) return '[redacted]';
    return entries.length ? `${entries.length} ${words(key)}` : undefined;
  }
  return undefined;
}

function expandedArguments(args: unknown, schema: Schema | undefined): string[] {
  let remaining = 80;
  const redact = (key: string, value: unknown, shape?: Schema, depth = 0): unknown => {
    if (secretName.test(key) || shape?.writeOnly || shape?.format === 'password')
      return '[redacted]';
    // Sensitivity may be hidden behind schema composition/references; fail closed for display.
    if (protectedSchema(shape)) return '[schema-protected]';
    if (--remaining < 0 || depth > 4) return '[preview limit]';
    if (typeof value === 'string') return plain(value, 240);
    if (Array.isArray(value)) {
      const items = value
        .slice(0, 8)
        .map((item, index) =>
          redact(String(index), item, shape?.prefixItems?.[index] ?? shape?.items, depth + 1),
        );
      if (value.length > 8) items.push(`[${value.length - 8} more items]`);
      return items;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      const result = Object.fromEntries(
        entries
          .slice(0, 8)
          .map(([child, item]) => [
            plain(child, 80),
            redact(
              child,
              item,
              shape?.properties?.[child] ?? shape?.additionalProperties,
              depth + 1,
            ),
          ]),
      );
      if (entries.length > 8) result['…'] = `${entries.length - 8} more fields`;
      return result;
    }
    return value;
  };
  if (protectedSchema(schema)) return ['arguments: [schema-protected]'];
  const entries = Object.entries(argsOf(args)).filter(([, value]) => value !== undefined);
  const lines = entries
    .slice(0, 16)
    .map(
      ([key, value]) =>
        `${plain(key, 80)}: ${plain(JSON.stringify(redact(key, value, schema?.properties?.[key] ?? schema?.additionalProperties)), 500)}`,
    );
  if (entries.length > 16) lines.push(`… ${entries.length - 16} more arguments`);
  return lines;
}

function dynamicParts(
  args: unknown,
  schema: Schema | undefined,
  expanded: boolean,
  complete: boolean,
) {
  if (protectedSchema(schema)) return { accent: '[schema-protected]' };
  const limit = expanded ? 240 : 80;
  const max = expanded ? 8 : 2;
  const shown: string[] = [];
  const muted: string[] = [];
  for (const [key, value] of Object.entries(argsOf(args))) {
    if (value === undefined) continue;
    if (qualifierName.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      muted.push(`${words(key)} ${value}`);
      continue;
    }
    if (shown.length >= max) continue;
    const text = preview(
      key,
      value,
      schema?.properties?.[key] ?? schema?.additionalProperties,
      limit,
    );
    if (text) shown.push(text);
  }
  const [accent, ...output] = shown;
  return {
    accent,
    output,
    muted,
    pending: !complete && shown.length === 0 && muted.length === 0,
  };
}

/** Display-only. Wire names, arguments and Pi's result renderer stay untouched. */
export function renderMcpCall(
  server: string,
  tool: { name: string; inputSchema?: Schema },
): Render {
  const thing = thingName(server);
  const action = actionName(tool.name);
  return (args, theme, context) =>
    textLine(
      context,
      paint(
        theme,
        action,
        thing || undefined,
        dynamicParts(args, tool.inputSchema, false, context.argsComplete),
      ) +
        (context.expanded
          ? expandedArguments(args, tool.inputSchema)
              .map((line) => `\n  ${theme.fg('toolOutput', line)}`)
              .join('')
          : ''),
    );
}

export function renderServerStatus(): Render {
  return (_args, theme, context) => textLine(context, command(theme, 'server status'));
}

export function renderSearchTools(): Render {
  return (args, theme, context) => {
    const data = argsOf(args);
    const server = typeof data.server === 'string' ? thingName(data.server) : undefined;
    const query = stringArg(data.query, context.expanded ? 240 : 80, context.argsComplete);
    const limit = ['limit', 'offset'].flatMap((key) =>
      typeof data[key] === 'number' && Number.isFinite(data[key]) ? [`${key} ${data[key]}`] : [],
    );
    return textLine(
      context,
      paint(theme, 'search tools', server || undefined, {
        accent: query.text,
        pending: query.pending,
        invalid: query.invalid || (data.server != null && typeof data.server !== 'string'),
        muted: limit,
      }),
    );
  };
}

export function renderTasks(): Render {
  return (args, theme, context) => {
    const data = argsOf(args);
    const server = typeof data.server === 'string' ? thingName(data.server) : undefined;
    const action = data.action;
    const invalidServer = data.server != null && typeof data.server !== 'string';
    if (action == null || action === 'list') {
      return textLine(
        context,
        paint(theme, 'tasks', server || undefined, {
          pending: action == null && !context.argsComplete,
          invalid: invalidServer || (action != null && action !== 'list'),
        }),
      );
    }
    if (action !== 'get' && action !== 'wait' && action !== 'cancel') {
      return textLine(context, paint(theme, 'tasks', server || undefined, { invalid: true }));
    }
    const task = stringArg(data.taskId, 80, context.argsComplete);
    return textLine(
      context,
      paint(theme, action, server || undefined, {
        accent: task.text,
        pending: task.pending,
        invalid: task.invalid || invalidServer,
      }),
    );
  };
}

export function renderResources(): Render {
  return (args, theme, context) => {
    const data = argsOf(args);
    const server = typeof data.server === 'string' ? thingName(data.server) : undefined;
    const invalidServer = data.server != null && typeof data.server !== 'string';
    const cursor =
      typeof data.cursor === 'string' && data.cursor ? [`cursor ${plain(data.cursor, 40)}`] : [];
    if (data.action === 'list' || data.action === 'templates') {
      return textLine(
        context,
        paint(theme, data.action === 'list' ? 'resources' : 'templates', server || undefined, {
          muted: cursor,
          invalid: invalidServer,
          pending: !server && !context.argsComplete,
        }),
      );
    }
    if (data.action === 'read') {
      const uri = stringArg(data.uri, context.expanded ? 240 : 120, context.argsComplete);
      return textLine(
        context,
        paint(theme, 'resource', server || undefined, {
          accent: uri.text,
          pending: uri.pending,
          invalid: uri.invalid || invalidServer,
          muted: cursor,
        }),
      );
    }
    return textLine(
      context,
      paint(theme, 'resources', server || undefined, {
        pending: !context.argsComplete,
        invalid: invalidServer || (data.action != null && typeof data.action !== 'string'),
      }),
    );
  };
}

export function renderComplete(): Render {
  return (args, theme, context) => {
    const data = argsOf(args);
    const server = typeof data.server === 'string' ? thingName(data.server) : undefined;
    const name = stringArg(data.name, 80, context.argsComplete);
    const limit = context.expanded ? 240 : 80;
    const output = [data.argument, data.value]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => plain(value, limit));
    return textLine(
      context,
      paint(theme, 'complete', server || undefined, {
        accent: name.text,
        output,
        pending: name.pending,
        invalid:
          name.invalid ||
          (data.server != null && typeof data.server !== 'string') ||
          (data.argument != null && typeof data.argument !== 'string') ||
          (data.value != null && typeof data.value !== 'string'),
      }),
    );
  };
}
