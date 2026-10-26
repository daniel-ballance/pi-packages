import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { detectInstallation, type Installation } from '../extensions/computer-use/src/installation.js';
import { ComputerSession } from '../extensions/computer-use/src/session.js';

async function fixture(): Promise<{
  session: ComputerSession; log: string; close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-computer-ssh-'));
  // Metacharacters must survive both the remote shell and env argument parsing.
  const app = join(root, "Dan's ChatGPT $(false); app.app");
  const resources = join(app, 'Contents/Resources');
  const launcher = join(resources, 'cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  const node = join(resources, 'cua_node/bin/node');
  const log = join(root, 'requests');
  const ssh = join(root, 'ssh');
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(node), { recursive: true });
  await symlink(process.execPath, node);
  const server = await readFile(new URL('./fixtures/server.mjs', import.meta.url), 'utf8');
  await writeFile(launcher, `process.argv[2] = ${JSON.stringify(log)};\n${server}`);
  await writeFile(ssh, '#!/bin/sh\nfor arg; do command=$arg; done\nexec /bin/sh -c "$command"\n');
  await chmod(ssh, 0o755);
  const detect = (): Installation => {
    const result = detectInstallation({ platform: 'linux', env: {
      PI_COMPUTER_USE_SSH: 'dan@mac-lan', PI_COMPUTER_USE_CHATGPT_APP: app,
      PI_COMPUTER_USE_COMPANION_APP: "/Applications/Dan's Companion.app",
      CODEX_HOME: '/must-not-forward-linux-codex-home',
    } });
    assert.ok(result.available);
    // Replace only the external SSH boundary. Execute the actual generated
    // remote command through a POSIX shell and use the real MCP/session stack.
    return { ...result, launch: { ...result.launch, command: ssh } };
  };
  const session = new ComputerSession(detect, 5000, 2000);
  return { session, log, close: async () => { await session.close(); await rm(root, { recursive: true, force: true }); } };
}

test('SSH carries persistent MCP state, images, all scoped operations, and fresh consent after reset', async () => {
  const f = await fixture();
  try {
    const environment = await f.session.execute({ code: 'environment' });
    assert.equal(environment.structuredContent?.surface, 'computer');
    assert.equal(environment.structuredContent?.companion, "/Applications/Dan's Companion.app");
    assert.equal(environment.structuredContent?.codexHome, undefined);
    assert.match(String(environment.structuredContent?.modules), /Dan's ChatGPT \$\(false\); app\.app/);
    assert.equal(environment.content[1].type, 'image');
    const first = await f.session.execute({ code: 'consent' });
    assert.deepEqual(first.structuredContent, { action: 'accept', content: {}, _meta: { persist: 'session' } });
    for (const operation of ['get_app_state', 'click', 'drag', 'paste', 'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text']) {
      const result = await f.session.execute({ code: `operation:${operation}` });
      assert.deepEqual(result.structuredContent, {
        action: 'accept', content: { source: 'computer-use-persisted-state' }, _meta: { persist: 'session' },
      }, operation);
    }
    assert.equal((await f.session.execute({ code: 'operation:unknown' })).structuredContent?.action, 'decline');
    assert.equal((await f.session.execute({ code: 'form' })).structuredContent?.action, 'decline');
    const messages = (await readFile(f.log, 'utf8')).trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(messages.filter(message => message.method === 'initialize').length, 1);
    await f.session.close();
    assert.deepEqual((await f.session.execute({ code: 'consent' })).structuredContent?.content, {});
  } finally { await f.close(); }
});

test('cancelling an SSH-backed call closes the connection and discards consent without replay', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await f.session.execute({ code: 'consent' });
    const running = f.session.execute({ code: 'hang' }, controller.signal);
    const rejected = assert.rejects(running, /may have partially completed/);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await readFile(f.log + '.worker'); ready = true; break; } catch { await delay(10); }
    }
    assert.ok(ready, 'Remote fixture must be executing before cancellation');
    controller.abort();
    await rejected;
    assert.equal(f.session.connected, false);
    assert.deepEqual((await f.session.execute({ code: 'consent' })).structuredContent?.content, {});
    const messages = (await readFile(f.log, 'utf8')).trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(messages.filter(message => message.params?.arguments?.code === 'hang').length, 1);
  } finally { controller.abort(); await f.close(); }
});

test('SSH failure is reported with stderr and is never retried or replaced by a local launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-computer-ssh-failure-'));
  const ssh = join(root, 'ssh');
  const log = join(root, 'attempts');
  await writeFile(ssh, `#!/bin/sh\nprintf x >> '${log}'\necho 'Permission denied (publickey).' >&2\nexit 255\n`);
  await chmod(ssh, 0o755);
  const detect = (): Installation => {
    const result = detectInstallation({ env: { PI_COMPUTER_USE_SSH: 'mac' } });
    assert.ok(result.available);
    return { ...result, launch: { ...result.launch, command: ssh } };
  };
  const session = new ComputerSession(detect, 1000, 500);
  try {
    await assert.rejects(session.execute({ code: 'state' }), /Permission denied \(publickey\)/);
    assert.equal(session.connected, false);
    assert.equal(await readFile(log, 'utf8'), 'x');
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});
