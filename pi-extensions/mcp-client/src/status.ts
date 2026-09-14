export interface HealthState {
  name: string;
  connected: boolean;
  error?: string;
  discoveryError?: string;
}

export interface HealthStatus {
  level: 'warning' | 'error';
  text: string;
}

/** No status means no footprint. Pending connections aren't failures. */
export function healthStatus(
  states: HealthState[],
  invalidConfig = false,
): HealthStatus | undefined {
  if (invalidConfig) return { level: 'error', text: '× MCP · invalid configuration' };
  const failed = states.filter((s) => s.error || s.discoveryError);
  if (!failed.length) return undefined;
  if (states.length && states.every((s) => !s.connected && s.error))
    return { level: 'error', text: '× MCP · unavailable' };
  const first = failed[0];
  // Server names are configuration data, not terminal escape sequences.
  const name = first.name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const short = name.length > 40 ? `${name.slice(0, 39)}…` : name;
  const issue = first.connected ? 'needs attention' : 'unavailable';
  return {
    level: 'warning',
    text: `⚠ MCP · ${short || 'server'} ${issue}${failed.length > 1 ? ` (+${failed.length - 1})` : ''}`,
  };
}
