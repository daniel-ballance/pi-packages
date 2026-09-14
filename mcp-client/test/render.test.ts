import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderMcpCall } from '../src/render.js';

type ToolRenderContext = Parameters<ReturnType<typeof renderMcpCall>>[2];

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function context(options: Partial<ToolRenderContext> = {}): ToolRenderContext {
  return { expanded: false, ...options } as ToolRenderContext;
}

test('friendly call headers and readable arguments without changing input', () => {
  const render = renderMcpCall('context7', {
    name: 'query-docs',
    title: 'Query documentation',
    inputSchema: { properties: { libraryId: { title: 'Library' } } },
  });
  const args = Object.freeze({
    libraryId: '/pydantic/pydantic-ai',
    query: 'Authenticate without CLI',
  });
  const lines = render(args, theme, context())
    .render(100)
    .map((line) => line.trimEnd());
  assert.deepEqual(lines, [
    'Context7 · Query documentation',
    '  Library: /pydantic/pydantic-ai',
    '  Query: Authenticate without CLI',
  ]);
  assert.equal(args.query, 'Authenticate without CLI');
});

test('untitled tools, partial arguments, falsy values and nested data render safely', () => {
  const render = renderMcpCall('my-server', { name: 'query_docs' });
  assert.deepEqual(
    render(undefined, theme, context())
      .render(100)
      .map((line) => line.trimEnd()),
    ['My server · Query docs'],
  );
  const text = render(
    { libraryId: 'x', count: 0, enabled: false, empty: null, pending: undefined },
    theme,
    context(),
  )
    .render(100)
    .join('\n');
  assert.match(text, /Library ID: x/);
  assert.match(text, /Count: 0/);
  assert.match(text, /Enabled: false/);
  assert.match(text, /Empty: null/);
  assert.doesNotMatch(text, /Pending/);
  assert.match(
    renderMcpCall('s', { name: 'fallback', annotations: { title: 'Legacy title' } })(
      {},
      theme,
      context(),
    ).render(100)[0],
    /Legacy title/,
  );
});

test('secret fields and terminal controls are hidden in display only', () => {
  const render = renderMcpCall('s\x1b[31m', {
    name: 'read',
    inputSchema: { properties: { opaque: { writeOnly: true } } },
  });
  const args = {
    apiKey: 'secret-1',
    opaque: 'secret-2',
    options: { password: 'secret-3', values: ['one', 'two'] },
    query: '\x1b]0;terminal title\x07hello\nworld',
  };
  const text = render(args, theme, context()).render(100).join('\n');
  assert.doesNotMatch(text, /secret-[123]|\x1b|terminal title/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /hello world/);
  assert.equal(args.options.password, 'secret-3');
});

test('argument previews are bounded, expand with Pi, and fit narrow terminals', () => {
  const render = renderMcpCall('context7', { name: 'query-docs' });
  const args = { query: '界'.repeat(5000), a: 1, b: 2, c: 3, d: 4, e: 5 };
  const collapsed = render(args, theme, context());
  assert.match(collapsed.render(100).join('\n'), /2 more arguments/);
  assert.ok(
    collapsed
      .render(100)
      .map((line) => line.trimEnd())
      .join('\n').length < 500,
  );
  const expanded = render(args, theme, context({ expanded: true, lastComponent: collapsed }));
  assert.equal(expanded, collapsed);
  assert.match(expanded.render(100).join('\n'), /E: 5/);
  assert.doesNotMatch(expanded.render(100).join('\n'), /more arguments/);
  for (const width of [10, 20, 40, 80]) {
    assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
  }
  const updated = render({ query: 'updated' }, theme, context({ lastComponent: expanded }));
  assert.match(updated.render(80).join('\n'), /updated/);
  assert.doesNotMatch(updated.render(80).join('\n'), /E: 5/);
});
