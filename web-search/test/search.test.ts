import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESPONSE_BYTES, parseResults, searchDuckDuckGo } from '../src/duckduckgo.js';
import extension from '../index.js';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

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
