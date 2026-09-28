import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESPONSE_BYTES, parseResults, searchDuckDuckGo } from '../src/duckduckgo.js';
import extension from '../index.js';
import type { ExtensionAPI, Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';

// Representative HTML fixtures: tests never contact DuckDuckGo.
const row = (href: string, title = 'Example &amp; docs', snippet = 'A <b>useful</b> snippet.') =>
  `<div class="result"><h2><a class="result__a" href="${href}">${title}</a></h2><a class="result__snippet">${snippet}</a></div>`;
const html = row('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1%26b%3D2&rut=abc')
  + row('https://second.example/', 'Second');
const responseFetch = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

test('extracts plain text, decodes redirect URLs, and preserves order/limit', () => {
  assert.deepEqual(parseResults(html, 1), [{
    title: 'Example & docs', url: 'https://example.com/docs?a=1&b=2', snippet: 'A useful snippet.',
  }]);
  assert.equal(parseResults(html).length, 2);
});

test('deduplicates, skips ads, invalid links and overlong URLs', () => {
  const input = row('https://example.com/') + row('https://example.com/')
    + row('javascript:alert(1)') + row('https://user:pass@example.org/')
    + row('/l/?uddg=javascript%3Aalert(1)') + row('https://example.com/' + 'x'.repeat(2048))
    + row('https://ad.example/').replace('class="result"', 'class="result result--ad"');
  assert.equal(parseResults(input).length, 1);
});

test('caps and sanitizes text without truncating URLs', () => {
  const [result] = parseResults(row('https://example.com/', '文'.repeat(300), '\u001b' + '文'.repeat(800)));
  assert.equal(result.title.length, 200);
  assert.equal(result.snippet.length, 500);
  assert.ok(result.snippet.endsWith('…'));
  assert.ok(!result.snippet.includes('\u001b'));
});

test('distinguishes confirmed no-results pages from blocking and markup changes', () => {
  assert.deepEqual(parseResults('<div class="no-results">No results found</div>'), []);
  assert.throws(() => parseResults('<form id="challenge-form"></form>'), /blocked/);
  assert.throws(() => parseResults('<form action="//duckduckgo.com/anomaly.js"></form>'), /blocked/);
  assert.throws(() => parseResults('<html>Unexpected content</html>'), /unrecognized/);
  // Search terms mentioning CAPTCHA must not be mistaken for a challenge.
  assert.equal(parseResults(row('https://example.com/', 'CAPTCHA and bots')).length, 1);
});

test('encodes queries and passes cancellation signal, without following redirects', async () => {
  await searchDuckDuckGo(' C++ & site:example.com ', 1, undefined, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://html.duckduckgo.com');
      assert.equal(url.searchParams.get('q'), 'C++ & site:example.com');
      assert.ok(init?.signal);
      assert.equal(init?.redirect, 'error');
      return new Response(html);
    },
  });
});

test('validates input before network access', async () => {
  const options = { fetch: async () => { throw new Error('unexpected request'); } };
  for (const query of ['', '   ', 'x'.repeat(1001)]) {
    await assert.rejects(searchDuckDuckGo(query, 5, undefined, options), /Query/);
  }
  for (const limit of [0, 11, 1.5, NaN]) {
    await assert.rejects(searchDuckDuckGo('query', limit, undefined, options), /Limit/);
  }
});

test('reports blocked HTTP responses and server errors', async () => {
  for (const status of [202, 403, 429]) {
    await assert.rejects(searchDuckDuckGo('test', 5, undefined, { fetch: responseFetch('', status) }), /blocked/);
  }
  await assert.rejects(searchDuckDuckGo('test', 5, undefined, { fetch: responseFetch('', 503) }), /HTTP 503/);
  await assert.rejects(searchDuckDuckGo('test', 5, undefined, { fetch: responseFetch('<form id="challenge-form"/>') }), /blocked/);
});

test('enforces streamed response size and cancels oversized bodies', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(searchDuckDuckGo('test', 5, undefined, {
    fetch: async () => new Response(body),
  }), /2 MiB/);
  assert.equal(cancelled, true);
});

const waitingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
  init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
});

test('supports cancellation before and during a request', async () => {
  const controller = new AbortController();
  const pending = searchDuckDuckGo('test', 5, controller.signal, { fetch: waitingFetch });
  controller.abort(new Error('user cancelled'));
  await assert.rejects(pending, /user cancelled/);
  await assert.rejects(searchDuckDuckGo('test', 5, controller.signal), /user cancelled/);
});

test('times out requests and body reads', async () => {
  await assert.rejects(searchDuckDuckGo('test', 5, undefined, {
    fetch: waitingFetch, timeoutMs: 10,
  }), /timed out/);
  await assert.rejects(searchDuckDuckGoBodyTimeout(), /timed out/);
});

function searchDuckDuckGoBodyTimeout() {
  return searchDuckDuckGo('test', 5, undefined, {
    timeoutMs: 10,
    fetch: async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      },
    })),
  });
}

test('registers web_search and returns bounded tool output', async () => {
  let tool: ToolDefinition | undefined;
  extension({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as ExtensionAPI);
  assert.equal(tool?.name, 'web_search');
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  assert.equal(tool!.renderCall!({ query: 'Authenticate without CLI', limit: 3 }, theme, { argsComplete: true, expanded: false } as never).render(120)[0].trimEnd(), 'web search Authenticate without CLI (limit 3)');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = responseFetch(Array.from({ length: 10 }, (_, i) =>
      row(`https://example.com/${i}/` + 'x'.repeat(2000), '文'.repeat(300), '文'.repeat(800))).join(''));
    const result = await tool!.execute('id', { query: 'test', limit: 10 }, undefined, undefined, {} as never);
    const text = result.content[0];
    assert.equal(text.type, 'text');
    if (text.type === 'text') {
      assert.ok(Buffer.byteLength(text.text) < 50 * 1024);
      assert.ok(text.text.split('\n').length < 2000);
      assert.match(text.text, /untrusted web content/);
    }
    globalThis.fetch = responseFetch('<form id="challenge-form"/>');
    await assert.rejects(tool!.execute('id', { query: 'test' }, undefined, undefined, {} as never), /blocked/);
    globalThis.fetch = responseFetch('<div class="no-results"/>');
    const empty = await tool!.execute('id', { query: 'test' }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(empty.content), /no results/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  extension({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as ExtensionAPI);
  return tool!;
}

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test('renders compact and expanded results without changing model content', () => {
  const tool = registeredTool();
  const results = Array.from({ length: 5 }, (_, i) => ({ title: `Title ${i}`, url: `https://example.com/${i}`, snippet: `Snippet ${i}` }));
  const result = { content: [{ type: 'text' as const, text: 'model-only JSON' }], details: { provider: 'duckduckgo', results } };
  const render = (expanded: boolean) => tool.renderResult!(result, { expanded, isPartial: false }, plainTheme, {} as never).render(120).join('\n');
  assert.match(render(false), /5 results.*snippets only.*pages not opened/);
  assert.match(render(false), /Title 0 — example.com/);
  assert.match(render(false), /2 more results/);
  assert.doesNotMatch(render(false), /Snippet|Title 4|model-only/);
  assert.match(render(true), /https:\/\/example.com\/4/);
  assert.match(render(true), /Snippet 4/);
  assert.equal(result.content[0].text, 'model-only JSON');
});

test('renders running, empty and failed results distinctly', () => {
  const tool = registeredTool();
  const result = { content: [{ type: 'text' as const, text: '[blocked] Do not retry.\u001b[31m' }], details: { provider: 'duckduckgo', results: [] } };
  const render = (isPartial: boolean, isError = false) => tool.renderResult!(result, { expanded: false, isPartial }, plainTheme, { isError } as never).render(120).join('\n');
  assert.match(render(true), /Searching DuckDuckGo/);
  assert.match(render(false), /no results.*broader query/);
  assert.match(render(false, true), /\[blocked\]/);
  assert.doesNotMatch(render(false, true), /no results|\u001b/);
});

test('expanded calls show complete queries and render safely at narrow widths', () => {
  const tool = registeredTool();
  const query = '文'.repeat(300) + ' final-token';
  const component = tool.renderCall!({ query }, plainTheme, { argsComplete: true, expanded: true } as never);
  assert.match(component.render(40).join('\n'), /final-token/);
  const partial = tool.renderCall!({}, plainTheme, { argsComplete: false } as never);
  assert.match(partial.render(40).join('\n'), /\.\.\./);
});

test('emits progress before results and preserves failed-tool semantics', async () => {
  const tool = registeredTool();
  const originalFetch = globalThis.fetch;
  const updates: unknown[] = [];
  try {
    globalThis.fetch = responseFetch(html);
    await tool.execute('id', { query: 'test' }, undefined, update => { updates.push(update); }, {} as never);
    assert.equal(updates.length, 1);
    assert.match(JSON.stringify(updates[0]), /Searching DuckDuckGo/);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(tool.execute('id', { query: 'test' }, undefined, undefined, {} as never), /\[network_error\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
