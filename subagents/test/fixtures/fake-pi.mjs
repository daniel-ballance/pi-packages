import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.lastIndexOf('--session') + 1];
let history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
let timer;
let working = false;
let pendingUI = false;
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const respond = (cmd, data) => emit({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
const settle = (text, error = false) => {
  clearTimeout(timer); working = false;
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: error ? 'error' : 'stop', errorMessage: error ? text : undefined } });
  emit({ type: 'agent_settled' });
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
    if (cmd.type === 'get_state') respond(cmd, { sessionFile: file, sessionId: 'fake-session', model: { provider: 'test', id: 'fake' }, thinkingLevel: 'medium', isStreaming: working });
    else if (cmd.type === 'get_session_stats') respond(cmd, { userMessages: history.length, cost: 0 });
    else if (cmd.type === 'prompt') {
      if (working && !cmd.streamingBehavior) { emit({ type: 'response', id: cmd.id, success: false, error: 'Already working' }); continue; }
      history.push(cmd.message); writeFileSync(file, JSON.stringify(history));
      if (cmd.message === 'crash') process.exit(2);
      if (cmd.message === 'malformed') { process.stdout.write('NOT JSON\n'); continue; }
      if (cmd.message === 'accept-before-start') {
        respond(cmd);
        timer = setTimeout(() => {
          working = true; emit({ type: 'agent_start' });
          timer = setTimeout(() => settle('late start finished'), 50);
        }, 80);
        continue;
      }
      working = true; emit({ type: 'agent_start' }); respond(cmd);
      clearTimeout(timer);
      if (cmd.message === 'ui') { pendingUI = true; emit({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Confirm test action?' }); }
      else timer = setTimeout(() => settle(`${history.length}:${cmd.message}`, cmd.message === 'error'), cmd.message.startsWith('slow') ? 5000 : 25);
    }
    else if (cmd.type === 'clear_queue') respond(cmd, { steering: [], followUp: [] });
    else if (cmd.type === 'abort') { if (working) settle('aborted'); respond(cmd); }
    else if (cmd.type === 'extension_ui_response' && pendingUI) { pendingUI = false; settle(`confirmed=${cmd.confirmed}`); }
    else emit({ type: 'response', id: cmd.id, success: false, error: 'Unknown command' });
  }
});
