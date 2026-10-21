import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type Installation =
  | { available: true; chatgptApp: string; companionApp: string; launch: Launch }
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

/** Detection does no work on other platforms and never starts or installs an app. */
export function detectInstallation(options: {
  platform?: string;
  home?: string;
  applications?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Installation {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { available: false, reason: 'Computer Use is inactive: this package requires macOS.' };
  }
  const home = options.home ?? homedir();
  const applications = options.applications ?? '/Applications';
  const env = options.env ?? process.env;
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
    return {
      available: true, chatgptApp, companionApp,
      launch: {
        command: node, args: [launcher], cwd: resources,
        env: {
          CUA_REPL_NODE_REPL_PATH: repl,
          CUA_REPL_ENABLED_SURFACES: 'computer',
          NODE_REPL_NODE_PATH: node,
          NODE_REPL_NODE_MODULE_DIRS: modules,
          NODE_REPL_TRUSTED_CODE_PATHS: modules,
          CODEX_CLI_PATH: cli,
          SKY_CUA_SERVICE_PATH: companionApp,
          CODEX_HOME: codexHome,
          SKY_ENABLE_AUDIO: '0',
        },
      },
    };
  }
  return {
    available: false,
    reason: 'Computer Use is inactive: ChatGPT\'s bundled computer-use runtime is missing or incomplete. Install or update ChatGPT, then /reload Pi.',
  };
}
