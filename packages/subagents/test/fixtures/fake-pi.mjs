import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.lastIndexOf('--session') + 1];
let history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
let timer;
let working = false;
let pendingUI = false;
let assistantMessages = history.length;
const emit = data => {
  if (data.type === 'message_end' && data.message?.role === 'assistant') assistantMessages++;
  process.stdout.write(JSON.stringify(data) + '\n');
};
const respond = (cmd, data) => emit({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
const settle = (text, error = false, stopReason = error ? 'error' : 'stop') => {
  clearTimeout(timer); working = false;
  emit({ type: 'message_end', message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], stopReason, errorMessage: error ? text : undefined } });
  emit({ type: 'agent_settled' });
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
    if (cmd.type === 'get_state') respond(cmd, { sessionFile: file, sessionId: 'fake-session', model: { provider: 'test', id: 'fake' }, thinkingLevel: 'medium', isStreaming: working, autoCompactionEnabled: true });
    else if (cmd.type === 'get_session_stats') respond(cmd, {
      userMessages: history.length, assistantMessages,
      cost: history.includes('live-usage') ? assistantMessages * 0.125 : Number(process.env.TEST_COST ?? 0),
      ...(history.includes('footer-stats') ? {
        tokens: { input: 1200, output: 340, cacheRead: 12000, cacheWrite: 800, total: 14340 },
        contextUsage: { tokens: 33728, contextWindow: 272000, percent: 12.4 },
      } : {}),
    });
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
      else if (cmd.message === 'live-usage') {
        emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse' } });
        emit({ type: 'turn_end' });
        timer = setTimeout(() => settle('finished'), 5000);
      }
      else if (cmd.message === 'split-settle') {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'early result' }], stopReason: 'stop' } });
        timer = setTimeout(() => { working = false; emit({ type: 'agent_settled' }); }, 150);
      }
      else if (cmd.message === 'footer-stats') {
        clearTimeout(timer); working = false;
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'stats' }], stopReason: 'stop',
          usage: { input: 100, output: 40, cacheRead: 300, cacheWrite: 20, totalTokens: 460, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } } });
        emit({ type: 'agent_settled' });
      }
      else timer = setTimeout(() => cmd.message === 'unrequested-cancel-error'
        ? settle('The operation was aborted.', true)
        : settle(`${history.length}:${cmd.message}`, cmd.message === 'error'), cmd.message.startsWith('slow') ? 5000 : 25);
    }
    else if (cmd.type === 'clear_queue') {
      if (working && history.at(-1) === 'slow-on-clear') settle('The operation was aborted.', true);
      respond(cmd, { steering: [], followUp: [] });
    }
    else if (cmd.type === 'abort') {
      if (!working && history.at(-1) === 'accept-before-start') {
        clearTimeout(timer); working = true; emit({ type: 'agent_start' });
      }
      if (working) {
        const last = history.at(-1);
        if (last === 'slow-genuine') settle('429 quota exceeded', true);
        else if (last === 'slow-native') settle('', false, 'aborted');
        else settle('The operation was aborted.', true); // Real openai-codex representation.
      }
      if (history.at(-1) === 'slow-delayed-ack') setTimeout(() => respond(cmd), 80);
      else respond(cmd);
    }
    else if (cmd.type === 'extension_ui_response' && pendingUI) { pendingUI = false; settle(`confirmed=${cmd.confirmed}`); }
    else emit({ type: 'response', id: cmd.id, success: false, error: 'Unknown command' });
  }
});
