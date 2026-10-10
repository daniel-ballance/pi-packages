import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadConfig, resolveConfig, ServerSchema } from '../extensions/mcp-client/src/config.js';
import {
  loadNativeConfig,
  type NativeRegistration,
} from '../extensions/mcp-client/src/native-config.js';

async function fixture(t: TestContext, ...files: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-native-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const path = join(dir, `${index}.json`);
    await writeFile(path, JSON.stringify(file));
    paths.push(path);
  }
  return paths;
}
async function loadEntry(t: TestContext, config: unknown) {
  return (await loadNativeConfig(await fixture(t, { mcpServers: { test: config } }))).test;
}

test('native imports seconds, enable flags and mixed-file extension fields without changing exposure', async (t) => {
  const paths = await fixture(t, {
    mcpServers: {
      mac: {
        type: 'stdio',
        command: 'never-executed',
        args: ['--fixture'],
        timeout: 120,
        exposure: 'codemode',
        toolExposure: { js_add_node_module_dir: 'hidden' },
        description: 'Computer use fixture',
      },
      playwright: {
        command: 'never-executed',
        args: [],
        protocol: '2025-11-25',
        toolLoading: 'deferred',
      },
      context7: { type: 'http', url: 'https://example.invalid/mcp', protocol: '2025-11-25' },
      disabled: { command: 'never-executed', enabled: false },
      enabled: { command: 'never-executed', enabled: true },
    },
  });
  const servers = await loadNativeConfig(paths);
  assert.equal(servers.mac.timeout, 120000);
  assert.equal(servers.mac.description, 'Computer use fixture');
  assert.deepEqual(servers.mac.toolExposure, { js_add_node_module_dir: 'hidden' });
  assert.equal(servers.playwright.toolLoading, 'deferred');
  assert.equal(servers.playwright.exposure, 'codemode');
  assert.equal(servers.playwright.protocol, '2025-11-25');
  assert.equal(servers.context7.transport, 'http');
  assert.equal(servers.disabled.disabled, true);
  assert.equal(servers.enabled.disabled, false);
  for (const server of Object.values(servers)) assert.equal(server.native, true);
  assert.equal(servers.disabled.timeout, 60000);
  assert.equal(servers.disabled.exposure, 'codemode');
});

test('native transport inference, exposure aliases and pattern order are retained', async (t) => {
  const servers = await loadNativeConfig(
    await fixture(t, {
      mcpServers: {
        local: {
          command: 'node',
          exposure: 'hidden',
          toolExposure: { 'read_*': 'codemode-deferred', '*': 'hidden', read_one: 'direct' },
          toolLoading: 'eager',
        },
        remote: { url: 'https://example.invalid' },
        alias: { type: 'streamable-http', url: 'https://example.invalid' },
        exposureAlias: { command: 'node', exposure: 'codemode-deferred' },
      },
    }),
  );
  assert.equal(servers.local.exposure, 'hidden');
  assert.equal(servers.local.transport, 'stdio');
  assert.deepEqual(servers.local.toolExposure, {
    'read_*': 'codemode',
    '*': 'hidden',
    read_one: 'direct',
  });
  assert.deepEqual(Object.keys(servers.local.toolExposure!), ['read_*', '*', 'read_one']);
  assert.equal(servers.remote.transport, 'http');
  assert.equal(servers.alias.transport, 'http');
  assert.equal(servers.exposureAlias.exposure, 'codemode');
});

test('transportless overrides preserve credentials, timeout and omitted restrictions', async (t) => {
  const paths = await fixture(
    t,
    {
      mcpServers: {
        local: {
          command: 'node',
          args: ['original'],
          env: { TOKEN: '${DO_NOT_RESOLVE_WHILE_LOADING}' },
          cwd: '~/server',
          timeout: 120,
          toolExposure: { secret: 'hidden' },
        },
        remote: {
          url: 'https://example.invalid',
          headers: { Authorization: 'Bearer fixture-only' },
          exposure: 'hidden',
        },
      },
    },
    { mcpServers: { local: { enabled: false, exposure: 'hidden' }, remote: { enabled: false } } },
  );
  const servers = await loadNativeConfig(paths);
  const local = servers.local;
  assert.equal(local.transport, 'stdio');
  if (local.transport !== 'stdio') throw new Error('expected stdio');
  assert.equal(local.disabled, true);
  assert.equal(local.exposure, 'hidden');
  assert.equal(local.timeout, 120000);
  assert.equal(local.command, 'node');
  assert.equal(local.cwd, '~/server');
  assert.deepEqual(local.args, ['original']);
  assert.deepEqual(local.env, { TOKEN: '${DO_NOT_RESOLVE_WHILE_LOADING}' });
  assert.deepEqual(local.toolExposure, { secret: 'hidden' });
  const remote = servers.remote;
  if (remote.transport === 'stdio') throw new Error('expected HTTP');
  assert.deepEqual(remote.headers, { Authorization: 'Bearer fixture-only' });
  assert.equal(remote.exposure, 'hidden');
  assert.equal(remote.disabled, true);
});

test('explicit toolExposure override replaces only that map in native order', async (t) => {
  const paths = await fixture(
    t,
    {
      mcpServers: {
        local: { command: 'node', exposure: 'hidden', toolExposure: { old: 'direct' } },
      },
    },
    { mcpServers: { local: { toolExposure: { 'read_*': 'codemode', '*': 'hidden' } } } },
  );
  const { local } = await loadNativeConfig(paths);
  assert.equal(local.exposure, 'hidden');
  assert.deepEqual(local.toolExposure, { 'read_*': 'codemode', '*': 'hidden' });
});

test('files override registrations, full definitions replace credentials, inputs are not mutated', async (t) => {
  const registrations: NativeRegistration[] = [
    {
      name: 'same',
      config: { command: 'registered', env: { TOKEN: 'not inherited' } },
      extensionPath: '/extension.ts',
    },
    { name: 'registeredOnly', config: { command: 'node', enabled: false } },
    { name: 'patched', config: { url: 'https://example.invalid', headers: { X: 'retained' } } },
  ];
  const before = structuredClone(registrations);
  const paths = await fixture(t, {
    mcpServers: { same: { command: 'file', enabled: false }, patched: { exposure: 'hidden' } },
  });
  const servers = await loadNativeConfig(paths, registrations);
  const same = servers.same;
  if (same.transport !== 'stdio') throw new Error('expected stdio');
  assert.equal(same.command, 'file');
  assert.deepEqual(same.env, {});
  assert.equal(same.disabled, true);
  assert.equal(servers.registeredOnly.disabled, true);
  assert.equal(servers.patched.exposure, 'hidden');
  assert.deepEqual(registrations, before);
});

test('native name validation and normalized namespace collisions fail closed, even when disabled', async (t) => {
  for (const name of ['', 'a.b', 'has space', 'a/b', 'emoji😀']) {
    await assert.rejects(
      loadNativeConfig([], [{ name, config: { command: 'node' } }]),
      /Invalid native MCP/,
    );
  }
  const paths = await fixture(
    t,
    { mcpServers: { 'a-b': { command: 'node', enabled: false } } },
    { mcpServers: { a_b: { command: 'node' } } },
  );
  await assert.rejects(loadNativeConfig(paths), /namespace collision/);
  await assert.rejects(
    loadNativeConfig([paths[1]], [{ name: 'a-b', config: { command: 'node' } }]),
    /namespace collision/,
  );
  await assert.rejects(
    loadNativeConfig(
      [],
      [
        { name: 'a-b', config: { command: 'node' } },
        { name: 'a_b', config: { command: 'node', enabled: false } },
      ],
    ),
    /namespace collision/,
  );
});

test('unknown fields and malformed disabled entries cannot erase policy or partially load', async (t) => {
  for (const config of [
    { command: 'node', disabled: true },
    { command: 'node', native: true },
    { command: 'node', transport: 'stdio' },
    { command: 'node', enabled: false, unknownRestriction: true },
    { command: 'node', enabled: 'false' },
    { command: 'node', exposure: 'typo' },
    { command: 'node', toolExposure: { secret: false } },
    { command: 'node', toolExposure: null },
    { command: 'node', toolLoading: 'hidden' },
    { command: 'node', protocol: '2020-01-01' },
    { command: 'node', elicitation: true },
    { command: 'node', url: 'https://example.invalid' },
    { command: 'node', type: 'http' },
    { url: 'https://example.invalid', type: 'stdio' },
    { url: 'https://example.invalid', type: 'sse' },
    { url: 'https://secret:password@example.invalid' },
    { url: 'file:///etc/passwd' },
    { enabled: false },
    null,
  ]) {
    await assert.rejects(loadEntry(t, config), /Invalid native MCP/);
  }
  const paths = await fixture(t, {
    mcpServers: { safe: { command: 'node' }, bad: { enabled: false, typo: true } },
  });
  await assert.rejects(loadNativeConfig(paths), /Invalid native MCP/);
  for (const file of [
    { mcpServers: {}, typo: true },
    { autoEnableCodemode: false },
    { servers: {} },
    [],
  ]) {
    await assert.rejects(loadNativeConfig(await fixture(t, file)), /Invalid native MCP/);
  }
});

test('transportless overrides accept only policy fields and require a base', async (t) => {
  const registrations = [{ name: 'test', config: { command: 'node', exposure: 'hidden' } }];
  for (const patch of [
    { timeout: 1 },
    { env: {} },
    { headers: {} },
    { protocol: 'auto' },
    { toolLoading: 'deferred' },
    { description: 'override' },
    { enabled: false, auth: {} },
  ]) {
    await assert.rejects(
      loadNativeConfig(await fixture(t, { mcpServers: { test: patch } }), registrations),
      /Invalid native MCP/,
    );
  }
  await assert.rejects(loadEntry(t, { enabled: false }), /requires an existing server/);
});

test('runtime options are a narrow per-server map and cannot change policy or credentials', async (t) => {
  const paths = await fixture(t, {
    mcpServers: {
      test: {
        command: 'node',
        enabled: false,
        exposure: 'hidden',
        timeout: 120,
        toolExposure: { secret: 'hidden' },
      },
    },
  });
  const options = {
    test: {
      protocol: '2025-11-25',
      elicitation: true,
      elicitationUrl: true,
      roots: [],
      sampling: true,
      samplingTools: true,
      tasks: true,
    },
  };
  const { test: server } = await loadNativeConfig(paths, [], options);
  for (const [key, value] of Object.entries(options.test))
    assert.deepEqual(server[key as keyof typeof server], value);
  assert.equal(server.disabled, true);
  assert.equal(server.exposure, 'hidden');
  assert.equal(server.timeout, 120000);
  assert.deepEqual(server.toolExposure, { secret: 'hidden' });
  for (const override of [
    { enabled: true },
    { disabled: false },
    { exposure: 'direct' },
    { toolExposure: {} },
    { timeout: 1 },
    { toolLoading: 'eager' },
    { native: false },
    { command: 'other' },
    { headers: {} },
    { oauth: {} },
    { unknown: true },
    { elicitation: 'yes' },
    { roots: [false] },
  ])
    await assert.rejects(loadNativeConfig(paths, [], { test: override }), /Invalid native MCP/);
  assert.equal(
    (await loadNativeConfig(paths, [], { absent: { elicitation: true } })).absent,
    undefined,
  );
  await assert.rejects(
    loadNativeConfig(paths, [], { absent: { enabled: true } }),
    /Invalid native MCP/,
  );
});

test('unsupported authentication and command-valued credentials reject without echoing values', async (t) => {
  for (const config of [
    { url: 'https://example.invalid', auth: { provider: 'private-provider' } },
    { url: 'https://example.invalid', oauth: { clientSecret: 'secret-marker' } },
    { url: 'https://example.invalid', oauth: { callbackUrl: 'http://localhost:12345/custom' } },
    { url: 'https://example.invalid', oauth: { clientRegistration: 'cimd' } },
    { url: 'https://example.invalid', oauth: { authServerMetadataUrl: 'https://example.invalid' } },
    {
      url: 'https://example.invalid',
      headers: { Authorization: '!secret-marker' },
      enabled: false,
    },
    { command: 'node', env: { TOKEN: '  !secret-marker' }, enabled: false },
    { command: '!secret-marker' },
  ])
    await assert.rejects(
      loadEntry(t, config),
      (error: Error) =>
        /Invalid native MCP/.test(error.message) && !error.message.includes('secret-marker'),
    );
  const server = await loadEntry(t, {
    url: 'https://example.invalid',
    oauth: { clientId: 'public-client', callbackPort: 12345, scope: 'read' },
  });
  if (server.transport === 'stdio') throw new Error('expected HTTP');
  assert.deepEqual(server.oauth, { clientId: 'public-client', redirectPort: 12345, scope: 'read' });
});

test('timeout conversion rejects out-of-range and sub-millisecond values without clamping', async (t) => {
  for (const [seconds, milliseconds] of [
    [0.1, 100],
    [1.001, 1001],
    [1.25, 1250],
    [60, 60000],
    [3600, 3600000],
  ]) {
    assert.equal((await loadEntry(t, { command: 'node', timeout: seconds })).timeout, milliseconds);
  }
  for (const timeout of [0, -1, 0.099, 1.0001, 3600.001, '60', null]) {
    await assert.rejects(loadEntry(t, { command: 'node', timeout }), /Invalid native MCP/);
  }
});

test('home and environment resolution is deferred; home expansion applies only to native paths', async (t) => {
  const input = {
    command: '~/bin/server',
    args: ['~', '~/file', '~other/file'],
    cwd: '~/work',
    env: { KEEP: '~/literal' },
  };
  const native = await loadEntry(t, input);
  const resolved = resolveConfig(native, '/session');
  if (resolved.transport !== 'stdio') throw new Error('expected stdio');
  assert.equal(resolved.command, join(homedir(), 'bin/server'));
  assert.deepEqual(resolved.args, [homedir(), join(homedir(), 'file'), '~other/file']);
  assert.equal(resolved.cwd, join(homedir(), 'work'));
  assert.deepEqual(resolved.env, { KEEP: '~/literal' });
  const legacy = resolveConfig(ServerSchema.parse({ transport: 'stdio', ...input }), '/session');
  if (legacy.transport !== 'stdio') throw new Error('expected stdio');
  assert.equal(legacy.command, '~/bin/server');
  assert.deepEqual(legacy.args, input.args);
  assert.equal(legacy.cwd, resolve('/session', '~/work'));
  const unresolved = await loadEntry(t, {
    command: 'node',
    env: { TOKEN: '${PI_NATIVE_CONFIG_TEST_UNSET_7412}' },
  });
  assert.throws(() => resolveConfig(unresolved, '/session'), /Missing environment variable/);
  const commandCredential = await loadEntry(t, {
    command: 'node',
    env: { TOKEN: '${PI_NATIVE_CONFIG_TEST_UNSET_7412:-!must-not-run}' },
  });
  assert.throws(() => resolveConfig(commandCredential, '/session'), /command-valued credentials/);
});

test('package loader retains millisecond semantics, defaults and strict unknown checks', async (t) => {
  const paths = await fixture(t, {
    mcpServers: { test: { command: 'node', timeout: 120, disabled: true } },
  });
  const { test: server } = await loadConfig(paths);
  assert.equal(server.timeout, 120);
  assert.equal(server.disabled, true);
  assert.equal(server.native, false);
  assert.equal(server.exposure, undefined);
  const normalized = ServerSchema.parse({
    transport: 'stdio',
    command: 'node',
    exposure: 'hidden',
    toolExposure: { secret: 'hidden' },
    description: 'fixture',
  });
  assert.equal(normalized.native, false);
  assert.equal(normalized.exposure, 'hidden');
  assert.deepEqual(normalized.toolExposure, { secret: 'hidden' });
  assert.equal(normalized.description, 'fixture');
  assert.throws(() =>
    ServerSchema.parse({
      transport: 'stdio',
      command: 'node',
      toolExposure: JSON.parse('{"__proto__":"hidden"}'),
    }),
  );
  for (const extra of [{ enabled: false }, { native: true }, { unknown: true }]) {
    await assert.rejects(
      loadConfig(await fixture(t, { mcpServers: { test: { command: 'node', ...extra } } })),
      /Invalid MCP configuration/,
    );
  }
});

test('missing files and empty native documents work; read/JSON errors are redacted', async (t) => {
  const paths = await fixture(t, {});
  assert.deepEqual(Object.keys(await loadNativeConfig([`${paths[0]}.missing`, ...paths])), []);
  await writeFile(paths[0], '{"secret-marker":');
  await assert.rejects(
    loadNativeConfig(paths),
    (error: Error) =>
      /Invalid JSON/.test(error.message) && !error.message.includes('secret-marker'),
  );
  await assert.rejects(
    loadNativeConfig([join(paths[0], '..')]),
    /Cannot read native MCP configuration/,
  );
});

test('reserved record keys are rejected rather than dropping hidden rules or credentials', async (t) => {
  for (const config of [
    JSON.parse('{"command":"node","toolExposure":{"__proto__":"hidden"}}'),
    JSON.parse('{"command":"node","env":{"__proto__":"secret"}}'),
    JSON.parse('{"url":"https://example.invalid","headers":{"__proto__":"secret"}}'),
  ])
    await assert.rejects(loadEntry(t, config), /reserved object key/);
  const file = JSON.parse('{"mcpServers":{"__proto__":{"command":"node","enabled":false}}}');
  await assert.rejects(loadNativeConfig(await fixture(t, file)), /reserved object key/);
});
