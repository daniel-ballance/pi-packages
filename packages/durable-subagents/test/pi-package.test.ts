import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const provider = fileURLToPath(new URL('./fixtures/pi-provider.mjs', import.meta.url));

for (const hostName of ['@earendil-works/pi-coding-agent', 'pi-host-1', ...(process.env.DURABLE_BUNDLED_PI_EXECUTABLE ? ['bundled-pi'] : [])]) {
test(`installed production tarball discovers tools and delivers native child results on ${hostName}`,  { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-pi-package-'));
  const agent = join(root, 'agent'); await mkdir(agent);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe' }));
    assert.ok(pack.files.some((f: { path: string }) => f.path === 'extensions/durable-subagents/index.ts'));
    assert.ok(pack.files.some((f: { path: string }) => f.path === 'src/runtime.ts'));
    assert.ok(!pack.files.some((f: { path: string }) => /^(test|node_modules)\//.test(f.path)));
    // Tarball resolution needs official registry metadata, even after npm ci cached exact archives.
    // This installs dependencies only; the subsequent Pi provider is strictly scripted/offline.
    execFileSync('npm', ['install', join(root, pack.filename), '--omit=dev', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, npm_config_offline: 'false' } });
    const installed = join(root, 'node_modules/@daniel-ballance/durable-subagents');
    const settings = SettingsManager.inMemory({ packages: [installed] });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: agent, settingsManager: settings });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some(e => e.path.endsWith('/extensions/durable-subagents/index.ts')));
    await assert.rejects(readFile(join(installed, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
    const hostCli = hostName === 'pi-host-1' ? fileURLToPath(new URL('../node_modules/pi-host-1/dist/bundle/cli.js', import.meta.url)) : cli;
    const fixtureEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
    const executable = hostName === 'bundled-pi' ? process.env.DURABLE_BUNDLED_PI_EXECUTABLE! : process.execPath;
    const prefix = hostName === 'bundled-pi' ? [] : [hostCli];
    execFileSync(executable, [...prefix, 'install', installed], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: fixtureEnv });
    assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).packages.length, 1);
    await writeFile(join(agent, 'durable-subagents.json'), JSON.stringify({ allowedModels: ['durable-fixture/scripted:off'], allowedTools: [], allowedRoots: [root], maxAgents: 2, maxActiveAssignments: 2, maxPeerMessages: 0 }));
    child = spawn(executable, [...prefix, '--mode', 'rpc', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-builtin-tools', '-e', provider, '--model', 'durable-fixture/scripted:off'], {
      cwd: root, env: fixtureEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: any[] = []; let buffer = '', stderr = '';
    child.stdout!.on('data', chunk => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { events.push(JSON.parse(line)); } catch {} } });
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) { if (Date.now() > deadline || child!.exitCode !== null) assert.fail(`${stderr}\n${JSON.stringify(events)}`); await new Promise(r => setTimeout(r, 20)); }
    };
    child.stdin!.write(JSON.stringify({ type: 'prompt', message: 'Exercise the native durable child.' }) + '\n');
    await wait(() => events.some(e => e.type === 'message_end' && e.message?.role === 'assistant' && e.message.content?.some((c: any) => c.text === 'PARENT REPORT RECEIVED')));
    const reports = events.filter(e => e.type === 'message_end' && e.message?.customType === 'durable-subagents-report');
    assert.equal(reports.length, 1);
    assert.match(reports[0].message.content, /CHILD RESULT/);
    assert.equal(events.filter(e => e.type === 'extension_error').length, 0);
    assert.ok(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'durable_subagent_spawn' && !e.isError));
    assert.ok(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'durable_subagent_send' && !e.isError));
    child.stdin!.write(JSON.stringify({ type: 'prompt', message: '/fixture-exit' }) + '\n');
    await wait(() => child!.exitCode === 0);
    assert.equal((await readdir(join(agent, 'durable-subagents'))).filter(f => f.endsWith('.lock')).length, 0, 'graceful Pi shutdown released host ownership');
    const sessionFiles = (await readdir(join(agent, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
    assert.equal(sessionFiles.length, 1);
    const previousEventCount = events.length;
    child = spawn(executable, [...prefix, '--mode', 'rpc', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-builtin-tools', '-e', provider, '--model', 'durable-fixture/scripted:off', '--session', join(agent, 'sessions', sessionFiles[0])], { cwd: root, env: fixtureEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { events.push(JSON.parse(line)); } catch {} } });
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    child.stdin!.write(JSON.stringify({ type: 'get_state', id: 'reopened-state' }) + '\n');
    await wait(() => events.some(e => e.id === 'reopened-state' && e.success));
    child.stdin!.write(JSON.stringify({ type: 'prompt', message: '/fixture-exit' }) + '\n');
    await wait(() => child!.exitCode === 0);
    assert.equal(events.slice(previousEventCount).filter(e => e.type === 'extension_error' || e.message?.customType === 'durable-subagents-report').length, 0);
    assert.equal((await readdir(join(agent, 'durable-subagents'))).filter(f => f.endsWith('.lock')).length, 0, 'reopened host released ownership');

  } finally { child?.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

}


test('bundled extension loads without workspace runtime dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-missing-deps-'));
  try {
    const source = join(root, 'source');
    await cp(packageRoot, source, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: SettingsManager.inMemory({ packages: [source] }) });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
