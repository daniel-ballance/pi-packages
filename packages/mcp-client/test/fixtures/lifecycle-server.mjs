import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [role, directory, mode] = process.argv.slice(2);
const record = (name, text) => writeFileSync(`${directory}/${name}`, text);
process.on('SIGTERM', () => {}); // Exercise escalation, not just cooperative exit.
setInterval(() => {}, 1000);

if (role === 'wrapper') {
  appendFileSync(`${directory}/starts`, `${process.pid}\n`);
  record('wrapper.pid', String(process.pid));
  const child = spawn(process.execPath, [import.meta.filename, 'server', directory, mode], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (message) => {
    if (message === 'exit-wrapper') process.exit(0);
  });
  child.on('exit', () => process.exit(0));
} else {
  record('server.pid', String(process.pid));
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    appendFileSync(`${directory}/requests`, `${message.method}\n`);
    if (message.method === 'exit-wrapper') {
      process.send('exit-wrapper');
      return;
    }
    if (!('id' in message) || mode === 'delayed') return;
    let result;
    if (message.method === 'initialize')
      result = { protocolVersion: message.params.protocolVersion, capabilities: {} };
    else if (message.method === 'server/discover')
      result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {} };
    else result = { resultType: 'complete' };
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  });
  record('ready', 'ready');
}
