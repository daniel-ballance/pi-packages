import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from '../extensions/mcp-client/src/connection.js';
import { ServerSchema, MODERN, LEGACY } from '../extensions/mcp-client/src/config.js';
import { StdioTransport } from '../extensions/mcp-client/src/stdio.js';
import { Peer } from '../extensions/mcp-client/src/peer.js';
import { deadline } from '../extensions/mcp-client/src/limits.js';

const fixture = fileURLToPath(new URL('./fixtures/lifecycle-server.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux', timeout: 10000 };
async function waitFor(check: () => Promise<boolean>) {
  await deadline(
    (async () => {
      for (let tries = 0; tries < 400; tries++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Fixture did not reach expected state');
    })(),
    5000,
  );
}
async function contents(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
}
async function state(pid: number) {
  const stat = await contents(`/proc/${pid}/stat`);
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : [];
}
async function running(pid: number) {
  const [status] = await state(pid);
  // Non-child zombies are awaiting their OS parent, not executing processes.
  return !!status && status !== 'Z' && status !== 'X';
}
async function setup(t: TestContext, mode = 'ready') {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-lifecycle-'));
  t.after(async () => {
    // Failure-only safety net targets only this fixture's recorded child PIDs.
    for (const role of ['server', 'wrapper']) {
      const pid = Number(await contents(join(directory, `${role}.pid`)));
      if (pid > 1 && pid !== process.pid && (await running(pid))) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const config = ServerSchema.parse({
    transport: 'stdio',
    command: process.execPath,
    args: [fixture, 'wrapper', directory, mode],
    protocol: MODERN,
    timeout: 5000,
  });
  assert.equal(config.transport, 'stdio');
  if (config.transport !== 'stdio') throw new Error('Expected stdio');
  const ready = async () => {
    await waitFor(async () => !!(await contents(join(directory, 'ready'))));
    const wrapper = Number(await contents(join(directory, 'wrapper.pid')));
    const server = Number(await contents(join(directory, 'server.pid')));
    assert.equal(Number((await state(wrapper))[2]), wrapper, 'wrapper owns a new group');
    assert.equal(Number((await state(server))[2]), wrapper, 'grandchild belongs to owned group');
    assert.notEqual(Number((await state(process.pid))[2]), wrapper, 'host group is not owned');
    return { wrapper, server };
  };
  return { config, directory, ready };
}

test('pre-aborted startup never configures or spawns a peer', linux, async (t) => {
  const { config, directory } = await setup(t);
  const abort = new AbortController();
  const reason = new Error('startup cancelled');
  abort.abort(reason);
  await assert.rejects(
    connect(
      config,
      {},
      () => assert.fail('must not configure'),
      undefined,
      undefined,
      abort.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(await contents(join(directory, 'starts')), '');
});

test('abort or throw from setup closes the unstarted transport', linux, async (t) => {
  const { config, directory } = await setup(t);
  for (const cancel of [true, false]) {
    const abort = new AbortController();
    const reason = new Error('setup stopped');
    let captured!: Peer;
    await assert.rejects(
      connect(
        config,
        {},
        (peer) => {
          captured = peer;
          if (cancel) abort.abort(reason);
          else throw reason;
        },
        undefined,
        undefined,
        abort.signal,
      ),
      (error) => error === reason,
    );
    await assert.rejects(captured.transport.start(), /closed/);
  }
  assert.equal(await contents(join(directory, 'starts')), '');
});

for (const protocol of [LEGACY[0], 'auto'] as const)
  test(
    `abort delayed ${protocol === 'auto' ? 'discovery' : 'initialize'} reaps owned tree without fallback`,
    linux,
    async (t) => {
      const { config, directory, ready } = await setup(t, 'delayed');
      const abort = new AbortController();
      const reason = new Error('cancel discovery');
      let captured!: Peer;
      let closes = 0;
      const connecting = connect(
        { ...config, protocol },
        {},
        (peer) => {
          captured = peer;
          peer.onclose = () => closes++;
        },
        undefined,
        undefined,
        abort.signal,
      );
      const rejected = assert.rejects(connecting, (error) => error === reason);
      t.after(() => captured?.close().catch(() => {}));
      const pids = await ready();
      const method = protocol === 'auto' ? 'server/discover' : 'initialize';
      await waitFor(async () => (await contents(join(directory, 'requests'))).includes(method));
      abort.abort(reason);
      await deadline(rejected, 3000);
      assert.equal(await running(pids.wrapper), false);
      assert.equal(await running(pids.server), false);
      assert.equal(closes, 1);
      assert.equal((await contents(join(directory, 'starts'))).trim().split('\n').length, 1);
      if (method === 'initialize')
        assert.equal(
          (await contents(join(directory, 'requests'))).includes('notifications/cancelled'),
          false,
        );
      await assert.rejects(captured.raw('ping'), /abort|closed/i);
    },
  );

test('startup deadline also tears down the owned tree', linux, async (t) => {
  const { config, ready } = await setup(t, 'delayed');
  const connecting = connect({ ...config, protocol: LEGACY[0], timeout: 1000 }, {}, () => {});
  const rejected = assert.rejects(connecting, /timed out|timeout/i);
  const pids = await ready();
  await deadline(rejected, 3000);
  assert.equal(await running(pids.wrapper), false);
  assert.equal(await running(pids.server), false);
});

test('immediate abort while spawn is pending waits for process exit', linux, async (t) => {
  const { config, directory } = await setup(t);
  const abort = new AbortController();
  let captured!: Peer;
  const connecting = connect(
    config,
    {},
    (peer) => {
      captured = peer;
    },
    undefined,
    undefined,
    abort.signal,
  );
  abort.abort();
  await assert.rejects(deadline(connecting, 3000), /abort/i);
  await captured.transport.close();
  await assert.rejects(captured.transport.start(), /closed/);
  for (const role of ['wrapper', 'server']) {
    const pid = Number(await contents(join(directory, `${role}.pid`)));
    if (pid) assert.equal(await running(pid), false);
  }
});

test('concurrent stdio close shares teardown and waits past SIGKILL', linux, async (t) => {
  const { config, ready } = await setup(t);
  const transport = new StdioTransport(config);
  t.after(() => transport.close());
  let closes = 0;
  transport.onclose = () => closes++;
  await transport.start();
  await assert.rejects(transport.start(), /already started/);
  const pids = await ready();
  const first = transport.close();
  assert.equal(first, transport.close());
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /closed/);
  await deadline(first, 3000);
  assert.equal(await running(pids.wrapper), false);
  assert.equal(await running(pids.server), false);
  assert.equal(closes, 1);
});

test('wrapper exit does not abandon a grandchild that ignores SIGTERM', linux, async (t) => {
  const { config, ready } = await setup(t);
  const transport = new StdioTransport(config);
  t.after(() => transport.close());
  let closed!: () => void;
  const exited = new Promise<void>((resolve) => {
    closed = resolve;
  });
  transport.onclose = closed;
  await transport.start();
  const pids = await ready();
  await transport.send({ jsonrpc: '2.0', method: 'exit-wrapper' });
  await deadline(exited, 3000);
  await transport.close();
  assert.equal(await running(pids.wrapper), false);
  assert.equal(await running(pids.server), false);
});

test('spawn failure and close before start remain idempotent', linux, async (t) => {
  const { config, directory } = await setup(t);
  const missing = new StdioTransport({ ...config, command: join(directory, 'missing') });
  await assert.rejects(missing.start(), /ENOENT/);
  await missing.close();
  await missing.close();
  const unstarted = new StdioTransport(config);
  const close = unstarted.close();
  assert.equal(close, unstarted.close());
  await close;
  await assert.rejects(unstarted.start(), /closed/);
});

test('startup signal is detached after success and headers remain optional', linux, async (t) => {
  const { config } = await setup(t);
  const abort = new AbortController();
  const peer = await connect(config, {}, () => {}, undefined, undefined, abort.signal);
  t.after(() => peer.close());
  abort.abort();
  assert.equal((await peer.request('ping')).resultType, 'complete');
  await peer.close();
});

for (const transport of ['http', 'sse'] as const)
  test(
    `abort during ${transport} startup closes in-flight HTTP I/O`,
    { timeout: 10000 },
    async () => {
      let arrived!: () => void;
      const requested = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const server = createServer((_req, res) => {
        res.on('close', disconnected);
        arrived(); // Deliberately never send discovery or SSE endpoint headers.
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const abort = new AbortController();
      const address = server.address();
      assert(address && typeof address !== 'string');
      const config = ServerSchema.parse({
        transport,
        url: `http://127.0.0.1:${address.port}`,
        protocol: transport === 'http' ? MODERN : LEGACY[0],
        timeout: 5000,
      });
      const connecting = connect(config, {}, () => {}, undefined, undefined, abort.signal);
      const rejected = assert.rejects(connecting, /abort/i);
      try {
        await deadline(requested, 3000);
        abort.abort();
        await deadline(rejected, 3000);
        await deadline(closed, 3000);
      } finally {
        abort.abort();
        await rejected;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
