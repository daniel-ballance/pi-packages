import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.lastIndexOf('--session') + 1];
let history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
let timer;
let working = false;
let pendingStart = false;
let pendingUI = false;
let followUps = [];
let assistantMessages = history.length;
let extraCost = 0;
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
      cost: extraCost + (history.includes('live-usage') ? assistantMessages * 0.125 : Number(process.env.TEST_COST ?? 0)),
      ...(history.includes('footer-stats') ? {
        tokens: { input: 1200, output: 340, cacheRead: 12000, cacheWrite: 800, total: 14340 },
        contextUsage: { tokens: 33728, contextWindow: 272000, percent: 12.4 },
      } : {}),
    });
    else if (cmd.type === 'prompt') {
      if (cmd.message === '/_child-policy-check') {
        emit({ type: 'entry_appended', entry: { type: 'custom', customType: 'child-policy-check', data: { tools: [] } } });
        respond(cmd, { disposition: 'handled' });
        continue;
      }
      if (cmd.message === 'CONSUME' || cmd.message === 'IDLE USAGE') {
        respond(cmd, { disposition: 'handled' });
        if (cmd.message === 'IDLE USAGE') setTimeout(() => {
          extraCost += 0.25;
          emit({ type: 'entry_appended', entry: { type: 'usage', usage: { cost: { total: 0.25 } } } });
        }, 30);
        continue;
      }
      // Pi 1.5.2 agent-loop: queued follow-ups enter a later turn of this
      // same run. An input hook can have changed the text before queue_update.
      if (working && history[0] === "queue-fixture-A" && cmd.streamingBehavior) {
        const queue = steering => emit({ type: "queue_update", followUp: [...followUps], steering });
        const user = text => emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
        if (cmd.streamingBehavior === "followUp") {
          followUps.push(cmd.message.replace("original", "delivered")); queue([]);
          respond(cmd, { disposition: "queued" }); continue;
        }
        queue([cmd.message]); queue([]); user(cmd.message);
        respond(cmd, { disposition: "queued" });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer A" }], stopReason: "stop" } });
        emit({ type: "turn_end" }); emit({ type: "turn_start" });
        const batch = [...followUps];
        while (followUps.length) { const text = followUps.shift(); queue([]); user(text); }
        settle("answer " + batch.join(" and ")); continue;
      }
      if (working && !cmd.streamingBehavior) { emit({ type: 'response', id: cmd.id, success: false, error: 'Already working' }); continue; }
      history.push(cmd.message); writeFileSync(file, JSON.stringify(history));
      if (cmd.message === 'crash') process.exit(2);
      if (cmd.message === 'malformed') { process.stdout.write('NOT JSON\n'); continue; }
      if (cmd.message === 'accept-before-start') {
        pendingStart = true;
        respond(cmd);
        // Cancellation tests release this start through abort, so a delayed
        // parent cannot accidentally close an already completed task.
        if (process.env.TEST_HOLD_RUN_START === '1') continue;
        timer = setTimeout(() => {
          pendingStart = false;
          working = true; emit({ type: 'agent_start' });
          timer = setTimeout(() => settle('late start finished'), 50);
        }, 80);
        continue;
      }
      working = true; emit({ type: 'agent_start' }); respond(cmd);
      clearTimeout(timer);
      if (cmd.message === 'ui') { pendingUI = true; emit({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Confirm test action?' }); }
      else if (cmd.message === 'inspector-stream') {
        emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'docs.md' } });
        emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'Documentation' }] }, isError: false });
        emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Live partial response' } });
        timer = setTimeout(() => settle('Live partial response, completed.'), 5000);
      }
      else if (cmd.message === 'live-usage') {
        emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse' } });
        emit({ type: 'turn_end' });
        timer = setTimeout(() => settle('finished'), 5000);
      }
      else if (cmd.message.startsWith('empty-final')) {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'progress'.repeat(2000) }], stopReason: 'toolUse' } });
        settle('');
      }
      else if (cmd.message.startsWith('evicted-final')) {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'actual final answer' }], stopReason: 'stop' } });
        for (let n = 0; n < 101; n++) emit({ type: 'extension_error', error: 'unrelated extension event' });
        working = false; emit({ type: 'agent_settled' });
      }
      else if (cmd.message === 'split-settle') {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'early result' }], stopReason: 'stop' } });
        timer = setTimeout(() => { working = false; emit({ type: 'agent_settled' }); }, 150);
      }
      else if (cmd.message === 'until-abort' || cmd.message === "queue-fixture-A") continue;
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
      if (pendingStart) {
        pendingStart = false;
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
