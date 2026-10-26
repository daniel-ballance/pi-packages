import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { detectInstallation } from '../extensions/computer-use/src/installation.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-computer-use-apps-'));
  const home = join(root, 'home');
  const applications = join(root, 'Applications');
  const chatgpt = join(applications, 'ChatGPT.app');
  const companion = join(home, '.codex/computer-use/Codex Computer Use.app');
  const put = async (path: string, executable = false) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
    if (executable) await chmod(path, 0o755);
  };
  const installRuntime = async () => {
    const resources = join(chatgpt, 'Contents/Resources');
    for (const name of ['cua_node/bin/node', 'cua_node/bin/node_repl', 'codex-cli/bin/codex']) {
      await put(join(resources, name), true);
    }
    for (const name of ['cua-repl/bin/cua-repl.mjs', 'sky/package.json', 'cua/package.json']) {
      await put(join(resources, 'cua_node/lib/node_modules/@oai', name));
    }
  };
  const installCompanion = async (path = companion) => {
    await put(join(path, 'Contents/Info.plist'));
    await put(join(path, 'Contents/MacOS/SkyComputerUseService'), true);
  };
  const options = { platform: 'darwin', home, applications, env: {} };
  return { root, home, applications, chatgpt, companion, installRuntime, installCompanion, options,
    close: () => rm(root, { recursive: true, force: true }) };
}

test('non-macOS stays inactive without an SSH destination', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const env = new Proxy({}, { get(_target: object, key: string | symbol): undefined {
      if (key !== 'PI_COMPUTER_USE_SSH') throw new Error('Local app environment must not be read');
      return undefined;
    } });
    const result = detectInstallation({ platform, env });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /requires macOS/);
  }
});

test('SSH configuration activates on Linux and macOS without inspecting local apps', () => {
  for (const platform of ['linux', 'darwin']) {
    const result = detectInstallation({ platform, home: '/missing', env: { PI_COMPUTER_USE_SSH: 'dan@100.120.109.108' } });
    assert.ok(result.available && result.mode === 'ssh');
    assert.equal(result.launch.command, 'ssh');
    assert.deepEqual(result.launch.args.slice(0, -1), [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=yes', 'dan@100.120.109.108',
    ]);
    assert.match(result.launch.args.at(-1)!, /CUA_REPL_ENABLED_SURFACES='computer'/);
    assert.match(result.launch.args.at(-1)!, /ChatGPT\.app/);
    assert.deepEqual(result.launch.env, {});
  }
});

test('invalid SSH destinations and remote app overrides fail closed without local fallback', () => {
  for (const destination of ['', '-oProxyCommand=evil', 'host command', 'user@host;evil', 'ssh://host', 'host\ncommand', 'user@@host', '::1', 'a'.repeat(256)]) {
    const result = detectInstallation({ platform: 'darwin', env: { PI_COMPUTER_USE_SSH: destination } });
    assert.equal(result.available, false, destination);
    if (!result.available) assert.match(result.reason, /PI_COMPUTER_USE_SSH/);
  }
  for (const key of ['PI_COMPUTER_USE_CHATGPT_APP', 'PI_COMPUTER_USE_COMPANION_APP']) {
    for (const path of ['relative.app', '~/ChatGPT.app', '', '/app\u0000.app', '/app\n.app']) {
      const result = detectInstallation({ env: { PI_COMPUTER_USE_SSH: 'mac', [key]: path } });
      assert.equal(result.available, false, path);
      if (!result.available) assert.ok(result.reason.includes(key));
    }
  }
});

test('requires the Companion even when the bundled runtime is installed', async () => {
  const f = await fixture();
  try {
    await f.installRuntime();
    const result = detectInstallation(f.options);
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /Companion app is not installed/);
    await mkdir(f.companion, { recursive: true });
    assert.equal(detectInstallation(f.options).available, false, 'an empty app directory is not installed');
  } finally { await f.close(); }
});

test('detects the installed apps and launches only the bundled signed runtime', async () => {
  const f = await fixture();
  try {
    await f.installRuntime(); await f.installCompanion();
    const result = detectInstallation(f.options);
    assert.ok(result.available && result.mode === 'local');
    assert.equal(result.chatgptApp, f.chatgpt);
    assert.equal(result.companionApp, f.companion);
    const resources = join(f.chatgpt, 'Contents/Resources');
    assert.equal(result.launch.command, join(resources, 'cua_node/bin/node'));
    assert.deepEqual(result.launch.args, [join(resources, 'cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]);
    assert.equal(result.launch.env.CUA_REPL_ENABLED_SURFACES, 'computer');
    assert.equal(result.launch.env.SKY_CUA_SERVICE_PATH, f.companion);
    assert.equal(result.launch.env.NODE_REPL_TRUSTED_CODE_PATHS, join(resources, 'cua_node/lib/node_modules'));
    assert.equal(result.launch.env.CODEX_CLI_PATH, join(resources, 'codex-cli/bin/codex'));
    await rm(join(resources, 'cua_node/bin/node_repl'));
    const missing = detectInstallation(f.options);
    assert.equal(missing.available, false);
    if (!missing.available) assert.match(missing.reason, /runtime is missing or incomplete/);
  } finally { await f.close(); }
});

test('supports the Companion alongside ChatGPT and explicit locations without fallback', async () => {
  const f = await fixture();
  try {
    await f.installRuntime();
    const companion = join(f.applications, 'Computer Use Companion.app');
    await f.installCompanion(companion);
    const result = detectInstallation(f.options);
    assert.ok(result.available && result.mode === 'local');
    assert.equal(result.companionApp, companion);
    const env = { PI_COMPUTER_USE_CHATGPT_APP: f.chatgpt, PI_COMPUTER_USE_COMPANION_APP: companion };
    assert.equal(detectInstallation({ ...f.options, env }).available, true);
    assert.equal(detectInstallation({ ...f.options, env: { ...env, PI_COMPUTER_USE_CHATGPT_APP: '/missing/ChatGPT.app' } }).available, false);
    assert.equal(detectInstallation({ ...f.options, env: { ...env, PI_COMPUTER_USE_COMPANION_APP: '/missing/Companion.app' } }).available, false);
    for (const path of ['relative.app', '~/Companion.app', '']) {
      const invalid = detectInstallation({ ...f.options, env: { PI_COMPUTER_USE_COMPANION_APP: path } });
      assert.equal(invalid.available, false);
      if (!invalid.available) assert.match(invalid.reason, /absolute path/);
    }
  } finally { await f.close(); }
});

test('respects CODEX_HOME and rejects non-executable bundled binaries', async () => {
  const f = await fixture();
  try {
    await f.installRuntime();
    const codexHome = join(f.root, 'Custom Codex');
    await f.installCompanion(join(codexHome, 'computer-use/Codex Computer Use.app'));
    assert.equal(detectInstallation({ ...f.options, env: { CODEX_HOME: codexHome } }).available, true);
    await chmod(join(f.chatgpt, 'Contents/Resources/cua_node/bin/node'), 0o644);
    assert.equal(detectInstallation({ ...f.options, env: { CODEX_HOME: codexHome } }).available, false);
  } finally { await f.close(); }
});
