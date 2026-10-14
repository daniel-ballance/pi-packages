import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export async function present(result: CallToolResult): Promise<AgentToolResult<{
  isError: boolean;
  fullOutput?: string;
}> & { isError?: boolean }> {
  const content: AgentToolResult<unknown>['content'] = [];
  let textBytes = 48 * 1024;
  let images = 0;
  let imageBytes = 0;
  let truncated = false;
  const text = (value: string) => {
    const bytes = Buffer.from(value);
    if (bytes.length > textBytes) truncated = true;
    // Avoid splitting a Unicode code point at the byte limit.
    let end = Math.min(textBytes, bytes.length);
    if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    if (end > 0) content.push({ type: 'text', text: bytes.subarray(0, end).toString('utf8') });
    textBytes -= end;
  };
  for (const block of result.content) {
    if (block.type === 'text') text(block.text);
    else if (block.type === 'image' &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType) &&
      images < 4 && imageBytes + block.data.length <= 8 * 1024 * 1024) {
      images++;
      imageBytes += block.data.length;
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else truncated = true;
  }
  if (result.structuredContent) text(JSON.stringify(result.structuredContent));
  let fullOutput: string | undefined;
  if (truncated) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-computer-use-'));
    fullOutput = join(directory, 'result.json');
    const { _meta: _private, ...publicResult } = result;
    await writeFile(fullOutput, JSON.stringify(publicResult), { mode: 0o600 });
    content.unshift({ type: 'text', text: `Full Computer Use result: ${fullOutput} (preview limited to 48 KiB and four images).` });
  }
  if (!content.length) content.push({ type: 'text', text: '(No output)' });
  return {
    content,
    details: { isError: result.isError === true, ...(fullOutput ? { fullOutput } : {}) },
    ...(result.isError ? { isError: true } : {}),
  };
}
