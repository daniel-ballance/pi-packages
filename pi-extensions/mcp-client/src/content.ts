import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { truncateHead, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { ObjectValue } from './headers.js';

/** Do not execute/fetch resource links, HTML, audio or server-provided URLs. */
export async function present(
  result: ObjectValue,
): Promise<AgentToolResult<{ mcpError: boolean; fullOutput?: string }>> {
  const content: AgentToolResult<unknown>['content'] = [];
  const text: string[] = [];
  let imageBytes = 0;
  const blocks =
    result.content ??
    result.contents?.map((resource: ObjectValue) => ({ type: 'resource', resource }));
  if (Array.isArray(blocks))
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      else if (
        block.type === 'image' &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType) &&
        typeof block.data === 'string' &&
        (imageBytes += block.data.length) <= 5 * 1024 * 1024 &&
        content.length < 4
      ) {
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data });
      } else if (block.type === 'resource' && typeof block.resource?.text === 'string')
        text.push(`${block.resource.uri}\n${block.resource.text}`);
      else text.push(JSON.stringify(block));
    }
  if (result.structuredContent !== undefined)
    text.push(JSON.stringify(result.structuredContent, null, 2));
  if (!blocks && result.structuredContent === undefined) text.push(JSON.stringify(result, null, 2));
  const full = text.join('\n\n') || '(No textual content)';
  const truncated = truncateHead(full);
  let fullOutput: string | undefined;
  let display = truncated.content;
  if (truncated.truncated) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-'));
    fullOutput = join(dir, 'result.json');
    await writeFile(fullOutput, JSON.stringify(result, null, 2), { mode: 0o600 });
    display += `\n[Output truncated to 2000 lines / 50 KiB. Full MCP result: ${fullOutput}]`;
  }
  content.unshift({ type: 'text', text: display });
  return {
    content,
    details: { mcpError: result.isError === true, ...(fullOutput ? { fullOutput } : {}) },
  };
}
