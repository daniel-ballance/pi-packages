import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const log = process.argv[2];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const pending = new Map();
let calls = 0;
let approvalId = 0;
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8h8AAAAASUVORK5CYII=' };
if (log) writeFileSync(log + '.pid', String(process.pid));

const requestConsent = (id, code) => {
  const requestId = `consent-${++approvalId}`;
  pending.set(requestId, id);
  send({ id: requestId, method: 'elicitation/create', params: {
    mode: 'form', message: 'Fixture request',
    requestedSchema: code === 'form' ? { type: 'object', properties: { password: { type: 'string' } } } : { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use',
      persist: ['session', 'always'], riskLevel: 'low', tool_name: code.startsWith('operation:') ? code.slice('operation:'.length) : code === 'click' ? 'click' : 'get_app_state',
      tool_params: { app: code === 'other-app' ? 'com.apple.TextEdit' : 'com.apple.calculator' }, tool_params_display: [],
    },
  } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + '\n');
  if (pending.has(message.id)) {
    const id = pending.get(message.id); pending.delete(message.id);
    result(id, { content: [{ type: 'text', text: 'consent result' }, image], structuredContent: message.result ?? message.error });
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    if (process.argv.includes('--hang-startup')) continue;
    result(message.id, { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} }, instructions: 'Fixture computer runtime' });
  } else if (message.method === 'tools/list') {
    result(message.id, { tools: [
      { name: 'js', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
      { name: 'js_reset', inputSchema: { type: 'object' } },
      { name: 'js_add_node_module_dir', inputSchema: { type: 'object' } },
      { name: 'turn_ended', inputSchema: { type: 'object' } },
    ] });
  } else if (message.method === 'tools/call') {
    if (message.params.name === 'turn_ended') { result(message.id, { content: [] }); continue; }
    calls++;
    const code = message.params.arguments.code;
    if (code === 'environment') result(message.id, {
      content: [{ type: 'text', text: 'environment' }, image],
      structuredContent: {
        surface: process.env.CUA_REPL_ENABLED_SURFACES,
        companion: process.env.SKY_CUA_SERVICE_PATH,
        codexHome: process.env.CODEX_HOME,
        modules: process.env.NODE_REPL_NODE_MODULE_DIRS,
      },
    });
    else if (['consent', 'click', 'other-app', 'form'].includes(code) || code.startsWith('operation:')) requestConsent(message.id, code);
    else if (code === 'hang') {
      // Exercise process-group cleanup after the launcher exits first, and
      // escalation for a child which ignores SIGTERM.
      const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'ignore'] });
      worker.stdout.once('data', () => { if (log) writeFileSync(log + '.worker', String(worker.pid)); });
    } else result(message.id, { content: [{ type: 'text', text: `state ${calls}` }, image], ...(code === 'error' ? { isError: true } : {}) });
  } else send({ id: message.id, error: { code: -32601, message: 'Unknown method' } });
}
