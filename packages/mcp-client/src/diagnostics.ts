import { stripVTControlCharacters } from 'node:util';
import { RpcError } from './peer.js';
import { HttpError } from './http.js';

/** Single-line display text, never terminal control sequences. Not a secret scrubber. */
export function displayText(value: string, limit = 240): string {
  const text = stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Only locally authored, value-free diagnostics may be displayed verbatim. */
export class DiagnosticError extends Error {}

export function failureReason(error: unknown): string {
  if (error instanceof DiagnosticError) return displayText(error.message, 800);
  if (error instanceof RpcError) return `Server returned RPC error ${error.code}`;
  if (error instanceof HttpError)
    return error.status === 401 || error.status === 403
      ? `HTTP ${error.status}: authorization refused; check credentials or use /mcp login SERVER for OAuth`
      : `HTTP ${error.status}`;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'Executable or file not found';
  if (code === 'EACCES') return 'Permission denied';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'Request timed out';
    if (error.name === 'AbortError') return 'Request cancelled';
    if (/^Missing environment variable: [A-Za-z_][A-Za-z0-9_]*$/.test(error.message))
      return error.message;
  }
  if (error instanceof SyntaxError) return 'Invalid JSON; check the command arguments';
  return 'Operation failed; check server configuration and advertised capabilities';
}
