import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CATALOG_BYTES = 10 * 1024 * 1024;
export const MAX_CATALOG_ITEMS = 2000;

/** Race even non-cooperative I/O; callers must also close/abort the underlying operation. */
export async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP operation timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bound JSON bodies and individual SSE events, including errors and legacy GET streams. */
export const boundedFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.body) return response;
  const sse = response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream';
  let bytes = 0,
    lineLength = 0,
    carriageReturn = false;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sse) {
          bytes += chunk.byteLength;
          if (bytes > MAX_MESSAGE_BYTES) throw new Error('MCP response exceeds 10 MiB');
        } else {
          for (const byte of chunk) {
            if (++bytes > MAX_MESSAGE_BYTES) throw new Error('MCP SSE event exceeds 10 MiB');
            if (byte === 10 && carriageReturn) {
              carriageReturn = false;
              continue;
            }
            carriageReturn = byte === 13;
            if (byte === 10 || byte === 13) {
              if (lineLength === 0) bytes = 0;
              lineLength = 0;
            } else lineLength++;
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
