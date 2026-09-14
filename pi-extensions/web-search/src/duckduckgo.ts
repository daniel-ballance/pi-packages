import { load } from 'cheerio';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BLOCKED = 'DuckDuckGo blocked this search (CAPTCHA or rate limit). Try again later; do not retry repeatedly.';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(value: string, max: number): string {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function resultUrl(href: string): string | undefined {
  try {
    let url = new URL(href, ENDPOINT);
    if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
      const target = url.searchParams.get('uddg');
      if (!target) return undefined;
      url = new URL(target);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    // Never truncate URLs into misleading/broken links.
    if (url.href.length > 2048) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseResults(html: string, limit = 5): SearchResult[] {
  const $ = load(html);
  if ($('#challenge-form, .anomaly-modal__modal, form[action*="anomaly.js"]').length) {
    throw new Error(BLOCKED);
  }
  $('script, style').remove();
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  $('.result').each((_index, element) => {
    const row = $(element);
    if (row.hasClass('result--ad') || row.find('.result__badge').length) return;
    const anchor = row.find('a.result__a').first();
    const url = resultUrl(anchor.attr('href') ?? '');
    const title = clip(anchor.text(), 200);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet: clip(row.find('.result__snippet').first().text(), 500) });
  });
  if (!results.length && !$('.no-results, .result--no-result').length) {
    throw new Error('DuckDuckGo returned an unrecognized page, not confirmed empty results. It may be blocking requests or its HTML may have changed.');
  }
  return results.slice(0, limit);
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error('DuckDuckGo returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('DuckDuckGo response exceeded the 2 MiB safety limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function searchDuckDuckGo(
  query: string,
  limit = 5,
  signal?: AbortSignal,
  // Dependency injection keeps tests offline, including timeout and cancellation tests.
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SearchResult[]> {
  query = query.trim();
  if (!query || query.length > 1000) throw new Error('Query must contain 1–1000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Limit must be an integer from 1 to 10.');
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 20_000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    const response = await (options.fetch ?? fetch)(url, {
      signal: combined,
      redirect: 'error',
      headers: { Accept: 'text/html', 'User-Agent': 'pi-web-search/0.1.0' },
    });
    if ([202, 403, 429].includes(response.status)) {
      await response.body?.cancel();
      throw new Error(BLOCKED);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`DuckDuckGo search failed (HTTP ${response.status}).`);
    }
    const html = await readBounded(response);
    combined.throwIfAborted();
    return parseResults(html, limit);
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.signal.aborted) throw new Error('DuckDuckGo search timed out. Try again later.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
