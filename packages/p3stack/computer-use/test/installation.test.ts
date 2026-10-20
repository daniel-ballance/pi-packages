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

test('non-macOS returns before inspecting paths or environment', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const env = new Proxy({}, { get() { throw new Error('Environment must not be read'); } });
    const result = detectInstallation({ platform, env });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /requires macOS/);
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
    assert.equal(result.available, true);
    if (!result.available) return;
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
    assert.equal(result.available, true);
    if (result.available) assert.equal(result.companionApp, companion);
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
