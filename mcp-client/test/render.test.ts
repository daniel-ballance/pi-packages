import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  renderComplete,
  renderMcpCall,
  renderResources,
  renderSearchTools,
  renderServerStatus,
  renderTasks,
} from '../src/render.js';

type ToolRenderContext = Parameters<ReturnType<typeof renderMcpCall>>[2];

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function context(options: Partial<ToolRenderContext> = {}): ToolRenderContext {
  return { expanded: false, argsComplete: true, ...options } as ToolRenderContext;
}
function lines(component: { render(width: number): string[] }, width = 120) {
  return component.render(width).map((line) => line.trimEnd());
}

test('server tool calls use the server as the thing and the tool name as the action', () => {
  const render = renderMcpCall('Context7', { name: 'query-docs' });
  const args = Object.freeze({
    libraryId: '/pydantic/pydantic-ai',
    query: 'Authenticate without CLI',
  });
  assert.deepEqual(lines(render(args, theme, context())), [
    'context7 • query docs /pydantic/pydantic-ai Authenticate without CLI',
  ]);
  assert.equal(args.query, 'Authenticate without CLI');
  assert.deepEqual(
    lines(
      renderMcpCall('playwright', { name: 'browser_navigate' })(
        { url: 'https://example.com' },
        theme,
        context(),
      ),
    ),
    ['playwright • navigate https://example.com'],
  );
  assert.deepEqual(
    lines(
      renderMcpCall('playwright', { name: 'browser_fill_form' })(
        { fields: [{}, {}, {}] },
        theme,
        context(),
      ),
    ),
    ['playwright • fill form 3 fields'],
  );
});

test('missing arguments stay inline and titles are not used as headings', () => {
  const render = renderMcpCall('my-server', { name: 'query_docs' });
  assert.deepEqual(lines(render(undefined, theme, context({ argsComplete: false }))), [
    'my-server • query docs ...',
  ]);
  assert.deepEqual(lines(render(undefined, theme, context())), ['my-server • query docs']);
  assert.equal(
    lines(renderMcpCall('s', { name: 'fallback' })({}, theme, context()))[0],
    's • fallback',
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
  const text = lines(render(args, theme, context({ expanded: true }))).join('\n');
  assert.doesNotMatch(text, /secret-[123]|\x1b|terminal title/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /hello world/);
  assert.equal(args.options.password, 'secret-3');
});

test('argument previews are bounded, expand with Pi, and fit narrow terminals', () => {
  const render = renderMcpCall('context7', { name: 'query-docs' });
  const args = { query: '界'.repeat(5000), a: 1, b: 2, c: 3, d: 4, e: 5 };
  const collapsed = render(args, theme, context());
  assert.match(lines(collapsed).join('\n'), /query docs/);
  assert.doesNotMatch(lines(collapsed).join('\n'), /\b5\b/);
  assert.ok(lines(collapsed).join('\n').length < 500);
  const expanded = render(args, theme, context({ expanded: true, lastComponent: collapsed }));
  assert.equal(expanded, collapsed);
  assert.match(lines(expanded).join('\n'), /\b5\b/);
  for (const width of [10, 20, 40, 80]) {
    assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
  }
  const updated = render({ query: 'updated' }, theme, context({ lastComponent: expanded }));
  assert.match(lines(updated, 80).join('\n'), /updated/);
  assert.doesNotMatch(lines(updated, 80).join('\n'), /\b5\b/);
});

test('built-in MCP calls omit the extension name unless a server is the thing', () => {
  assert.equal(lines(renderServerStatus()({}, theme, context()))[0], 'server status');
  assert.equal(
    lines(renderSearchTools()({ query: 'pydantic', limit: 5 }, theme, context()))[0],
    'search tools pydantic (limit 5)',
  );
  assert.equal(
    lines(renderSearchTools()({ server: 'Context7', query: 'pydantic' }, theme, context()))[0],
    'context7 • search tools pydantic',
  );
  assert.equal(lines(renderTasks()({ action: 'list' }, theme, context()))[0], 'tasks');
  assert.equal(
    lines(
      renderTasks()({ action: 'wait', server: 'context7', taskId: '8f3a' }, theme, context()),
    )[0],
    'context7 • wait 8f3a',
  );
  assert.equal(
    lines(
      renderResources()(
        { server: 'context7', action: 'read', uri: 'file:///src/index.ts' },
        theme,
        context(),
      ),
    )[0],
    'context7 • resource file:///src/index.ts',
  );
  assert.equal(
    lines(
      renderComplete()(
        {
          server: 'context7',
          type: 'ref/prompt',
          name: 'review',
          argument: 'language',
          value: 'typescript',
        },
        theme,
        context(),
      ),
    )[0],
    'context7 • complete review language typescript',
  );
});
