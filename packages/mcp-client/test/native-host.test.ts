import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  nativeToolNames,
  nativeDefinitionFields,
  toolExposure,
} from '../extensions/mcp-client/src/native-host.js';
import { loadClientSettings } from '../extensions/mcp-client/src/client-settings.js';
import { presentNativeResult, present } from '../extensions/mcp-client/src/content.js';

test('native exposure obeys exact then first wildcard then default; hidden can expose exceptions', () => {
  const config = {
    exposure: 'hidden' as const,
    toolExposure: {
      'read*': 'codemode' as const,
      '*': 'hidden' as const,
      read_private: 'hidden' as const,
      public: 'direct' as const,
    },
  };
  assert.equal(toolExposure(config, 'read_private'), 'hidden');
  assert.equal(toolExposure(config, 'read_public'), 'codemode');
  assert.equal(toolExposure(config, 'other'), 'hidden');
  assert.equal(toolExposure(config, 'public'), 'direct');
  assert.equal(
    toolExposure({ exposure: 'direct', toolExposure: { 'a.b*': 'hidden' } }, 'axbfoo'),
    'direct',
  );
  assert.equal(
    toolExposure({ exposure: 'direct', toolExposure: { 'a.b*': 'hidden' } }, 'a.bfoo'),
    'hidden',
  );
});

test('native identities are stable, bounded and order-independent for colliding names', () => {
  const names = ['js', 'a-b', 'a_b', 'x'.repeat(200)];
  const ids = nativeToolNames('mac-computer-use', names);
  assert.equal(ids.get('js'), 'mcp__mac_computer_use__js');
  assert.notEqual(ids.get('a-b'), ids.get('a_b'));
  for (const [tool, id] of ids) {
    assert.ok(id.length <= 64);
    assert.equal(id, nativeToolNames('mac-computer-use', names.toReversed()).get(tool));
  }
});

test('native definitions provide namespace, safe annotations and full-result schema', () => {
  const fields = nativeDefinitionFields(
    'mac-computer-use',
    { name: 'js', annotations: { readOnlyHint: true, destructiveHint: 'untrusted' } },
    { exposure: 'codemode' },
    'Computer documentation',
  );
  assert.equal(fields.exposure, 'deferred');
  assert.equal(fields.namespace.name, 'mcp__mac_computer_use');
  assert.equal(fields.namespace.instructions, 'Computer documentation');
  assert.deepEqual(fields.annotations, { readOnlyHint: true });
  assert.deepEqual(JSON.parse(JSON.stringify(fields.outputSchema)).required, ['content']);
});

test('native results retain full script data and error/image blocks while stripping top-level meta', async () => {
  const raw = {
    content: [{ type: 'text', text: 'x'.repeat(60000) }],
    structuredContent: { n: 4 },
    isError: true,
    _meta: { credential: 'not-for-model' },
  };
  const result = await presentNativeResult(raw);
  try {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.content[0].text.length, 60000);
    assert.equal(result.structuredContent._meta, undefined);
    assert.equal(JSON.stringify(result).includes('not-for-model'), false);
    assert.ok(result.details.fullOutput);
  } finally {
    if (result.details.fullOutput)
      await rm(join(result.details.fullOutput, '..'), { recursive: true, force: true });
  }
  const image = await present({
    contents: [{ uri: 'fixture:image', mimeType: 'image/png', blob: 'abcd' }],
  });
  assert.equal(image.content[0].type, 'image');
});

test('client settings are explicit, layered and never enable permanent persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-client-settings-'));
  const global = join(dir, 'global.json');
  const project = join(dir, 'project.json');
  try {
    assert.equal((await loadClientSettings([global])).configurationFormat, 'package');
    await writeFile(
      global,
      JSON.stringify({
        configurationFormat: 'native',
        serverOptions: { mac: { elicitation: true } },
      }),
    );
    await writeFile(
      project,
      JSON.stringify({
        computerUse: {
          mac: {
            apps: ['com.apple.calculator'],
            operations: ['get_app_state'],
            persistence: 'session',
          },
        },
      }),
    );
    const settings = await loadClientSettings([global, project]);
    assert.equal(settings.configurationFormat, 'native');
    assert.equal(settings.serverOptions.mac.elicitation, true);
    assert.equal(settings.computerUse.mac.persistence, 'session');
    await writeFile(
      project,
      JSON.stringify({
        computerUse: {
          mac: {
            apps: ['com.apple.calculator'],
            operations: ['get_app_state'],
            persistence: 'always',
          },
        },
      }),
    );
    await assert.rejects(loadClientSettings([global, project]), /Invalid MCP client settings/);
    await writeFile(
      project,
      JSON.stringify({
        configurationFormat: 'package',
        serverOptions: { mac: { elicitation: true } },
      }),
    );
    await assert.rejects(loadClientSettings([project]), /requires explicit native/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
