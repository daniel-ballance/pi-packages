import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type Installation =
  | { available: true; mode: 'local'; chatgptApp: string; companionApp: string; launch: Launch }
  | { available: true; mode: 'ssh'; destination: string; chatgptApp: string; launch: Launch }
  | { available: false; reason: string };

function file(path: string, executable = false): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function companion(path: string): boolean {
  if (!file(join(path, 'Contents/Info.plist'))) return false;
  try {
    const bin = join(path, 'Contents/MacOS');
    return readdirSync(bin).some(name => file(join(bin, name), true));
  } catch {
    return false;
  }
}

/** Both transports use only the original bundled runtime and computer surface. */
function bundledLaunch(chatgptApp: string): Launch {
  const resources = posix.join(chatgptApp, 'Contents/Resources');
  const runtime = posix.join(resources, 'cua_node');
  const modules = posix.join(runtime, 'lib/node_modules');
  const node = posix.join(runtime, 'bin/node');
  return {
    command: node, args: [posix.join(modules, '@oai/cua-repl/bin/cua-repl.mjs')], cwd: resources,
    env: {
      CUA_REPL_NODE_REPL_PATH: posix.join(runtime, 'bin/node_repl'),
      CUA_REPL_ENABLED_SURFACES: 'computer',
      NODE_REPL_NODE_PATH: node,
      NODE_REPL_NODE_MODULE_DIRS: modules,
      NODE_REPL_TRUSTED_CODE_PATHS: modules,
      CODEX_CLI_PATH: posix.join(resources, 'codex-cli/bin/codex'),
      SKY_ENABLE_AUDIO: '0',
    },
  };
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function remoteInstallation(env: NodeJS.ProcessEnv, destination: string): Installation {
  // One destination only, never options, URLs, shell fragments, or paths.
  if (destination.length > 255 || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(destination)) {
    return { available: false, reason: 'Computer Use is inactive: PI_COMPUTER_USE_SSH must be an SSH host alias or [user@]hostname/IP, without options or whitespace.' };
  }
  for (const key of ['PI_COMPUTER_USE_CHATGPT_APP', 'PI_COMPUTER_USE_COMPANION_APP']) {
    const path = env[key];
    if (path !== undefined && (!posix.isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path))) {
      return { available: false, reason: `Computer Use is inactive: ${key} must be an absolute Mac path without control characters.` };
    }
  }
  const chatgptApp = env.PI_COMPUTER_USE_CHATGPT_APP ?? '/Applications/ChatGPT.app';
  const runtime = bundledLaunch(chatgptApp);
  if (env.PI_COMPUTER_USE_COMPANION_APP !== undefined) runtime.env.SKY_CUA_SERVICE_PATH = env.PI_COMPUTER_USE_COMPANION_APP;
  // SSH joins command arguments through the remote login shell. Quote every
  // value, including paths with spaces or apostrophes; no local shell is used.
  const command = ['exec env', ...Object.entries(runtime.env).map(([key, value]) => `${key}=${quote(value)}`),
    quote(runtime.command), ...runtime.args.map(quote)].join(' ');
  return {
    available: true, mode: 'ssh', destination, chatgptApp,
    launch: {
      command: 'ssh', args: [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=yes', destination, command,
      ], env: {}, cwd: homedir(),
    },
  };
}

/** Detection never connects, starts processes, or installs apps. SSH is opt-in. */
export function detectInstallation(options: {
  platform?: string;
  home?: string;
  applications?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Installation {
  const env = options.env ?? process.env;
  if (env.PI_COMPUTER_USE_SSH !== undefined) return remoteInstallation(env, env.PI_COMPUTER_USE_SSH);
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { available: false, reason: 'Computer Use is inactive: this package requires macOS.' };
  }
  const home = options.home ?? homedir();
  const applications = options.applications ?? '/Applications';
  for (const key of ['PI_COMPUTER_USE_CHATGPT_APP', 'PI_COMPUTER_USE_COMPANION_APP', 'CODEX_HOME']) {
    if (env[key] !== undefined && !isAbsolute(env[key]!)) {
      return { available: false, reason: `Computer Use is inactive: ${key} must be an absolute path.` };
    }
  }
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  const companions = env.PI_COMPUTER_USE_COMPANION_APP !== undefined
    ? [env.PI_COMPUTER_USE_COMPANION_APP]
    : [
        join(codexHome, 'computer-use/Codex Computer Use.app'),
        join(codexHome, 'computer-use/Computer Use Companion.app'),
        join(applications, 'Computer Use Companion.app'),
        join(applications, 'Codex Computer Use.app'),
        join(home, 'Applications/Computer Use Companion.app'),
        join(home, 'Applications/Codex Computer Use.app'),
      ];
  const companionApp = companions.find(companion);
  if (!companionApp) {
    return {
      available: false,
      reason: 'Computer Use is inactive: the Computer Use Companion app is not installed. Install the Computer Use plugin in ChatGPT, then /reload Pi.',
    };
  }
  const apps = env.PI_COMPUTER_USE_CHATGPT_APP !== undefined
    ? [env.PI_COMPUTER_USE_CHATGPT_APP]
    : [
        join(applications, 'ChatGPT.app'),
        join(home, 'Applications/ChatGPT.app'),
        join(applications, 'Codex.app'),
        join(home, 'Applications/Codex.app'),
      ];
  for (const chatgptApp of apps) {
    const resources = join(chatgptApp, 'Contents/Resources');
    const runtime = join(resources, 'cua_node');
    const modules = join(runtime, 'lib/node_modules');
    const node = join(runtime, 'bin/node');
    const repl = join(runtime, 'bin/node_repl');
    const cli = join(resources, 'codex-cli/bin/codex');
    const launcher = join(modules, '@oai/cua-repl/bin/cua-repl.mjs');
    if (![node, repl, cli].every(path => file(path, true)) ||
        ![launcher, join(modules, '@oai/sky/package.json'), join(modules, '@oai/cua/package.json')].every(path => file(path))) continue;
    const launch = bundledLaunch(chatgptApp);
    return {
      available: true, mode: 'local', chatgptApp, companionApp,
      launch: { ...launch, env: { ...launch.env, SKY_CUA_SERVICE_PATH: companionApp, CODEX_HOME: codexHome } },
    };
  }
  return {
    available: false,
    reason: 'Computer Use is inactive: ChatGPT\'s bundled computer-use runtime is missing or incomplete. Install or update ChatGPT, then /reload Pi.',
  };
}
