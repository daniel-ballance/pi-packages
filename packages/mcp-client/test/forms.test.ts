import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGuide, fillFields } from '../extensions/mcp-client/src/forms.js';
import { inputHandler } from '../extensions/mcp-client/src/input.js';
import { ServerSchema } from '../extensions/mcp-client/src/config.js';

const schema = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 3 },
    style: { type: 'string', enum: ['compact', 'detailed'] },
    enabled: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['count', 'style', 'enabled'],
};
const config = ServerSchema.parse({ transport: 'stdio', command: 'unused', elicitation: true });
function ui(selects: (string | undefined)[], inputs: (string | undefined)[]) {
  const titles: string[] = [],
    notices: string[] = [],
    menus: string[][] = [];
  const ctx: any = {
    hasUI: true,
    cwd: '/tmp',
    ui: {
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        menus.push(choices);
        return selects.shift();
      },
      input: async (title: string) => {
        titles.push(title);
        return inputs.shift();
      },
      notify: (text: string) => notices.push(text),
    },
  };
  return { ctx, titles, notices, menus };
}

test('guided forms are a bounded scalar subset; secrets and complex schemas use JSON fallback', () => {
  assert.equal(canGuide(schema), true);
  for (const value of [
    { ...schema, allOf: [{}] },
    { ...schema, required: ['missing'] },
    { type: 'object', properties: { items: { type: 'array' } } },
    { type: 'object', properties: { password: { type: 'string' } } },
    { type: 'object', properties: { opaque: { type: 'string', writeOnly: true } } },
    { type: 'object', properties: { opaque: { type: 'string', format: 'password' } } },
    { type: 'object', properties: { field: { $ref: '#/$defs/field' } } },
    {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [String(i), { type: 'string' }]),
      ),
    },
  ])
    assert.equal(canGuide(value), false);
});

test('guided elicitation validates fields, preserves false, skips optional input, and requires release', async () => {
  const h = ui(
    ['Fill in fields', '2. "detailed"', '2. false', 'Skip', 'Send answers'],
    ['999', '2'],
  );
  const result = await inputHandler(
    'fixture',
    config,
    h.ctx,
  )('elicitation/create', { message: 'Choose preferences', requestedSchema: schema });
  assert.equal(result.action, 'accept');
  assert.deepEqual({ ...result.content }, { count: 2, style: 'detailed', enabled: false });
  assert.match(h.notices[0], /count: maximum constraint failed/);
  assert.doesNotMatch(h.notices.join('\n'), /999/);
  assert.match(h.titles.at(-1)!, /review answers before sending.*\ncount: 2/);
  assert.match(h.titles.at(-1)!, /enabled: false/);
  assert.deepEqual(h.menus.at(-1), ['Send answers', 'Cancel']);
});

test('guided cancellation and decline never release partial content', async () => {
  const simple = {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
  };
  for (const [selects, inputs, expected] of [
    [[undefined], [], 'cancel'],
    [['Decline'], [], 'decline'],
    [['Fill in fields'], [undefined], 'cancel'],
    [['Fill in fields', 'Cancel'], ['2'], 'cancel'],
    [['Fill in fields', undefined], ['2'], 'cancel'],
  ] as [(string | undefined)[], (string | undefined)[], string][]) {
    const h = ui(selects, inputs);
    assert.deepEqual(
      await inputHandler(
        'fixture',
        config,
        h.ctx,
      )('elicitation/create', { message: 'Choose', requestedSchema: simple }),
      { action: expected },
    );
  }
});

test('non-finite numeric input is rejected and retry count is bounded', async () => {
  const simple = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
  const h = ui([], ['Infinity', '', 'NaN']);
  assert.equal(await fillFields(h.ctx, 'Fixture', simple, { timeout: 1000 }), undefined);
  assert.equal(h.notices.length, 3);
  assert.ok(h.notices.every((text) => text.includes('finite number')));
  assert.match(h.notices.at(-1)!, /cancelled after three invalid/);
});

test('advanced JSON remains available; malformed input errors do not echo values', async () => {
  const h = ui(['Provide JSON'], ['{private-invalid-value', '{"name":"ok"}']);
  const complex = {
    allOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }],
  };
  const result = await inputHandler(
    'fixture',
    config,
    h.ctx,
  )('elicitation/create', { message: 'Reference schema', requestedSchema: complex });
  assert.deepEqual(result, { action: 'accept', content: { name: 'ok' } });
  assert.deepEqual(h.menus[0], ['Provide JSON', 'Decline']);
  assert.doesNotMatch(h.notices.join('\n'), /private-invalid-value/);
});

test('headless input fails closed and abort during entry cannot release answers', async () => {
  const h = ui(['Fill in fields'], ['2']);
  h.ctx.hasUI = false;
  await assert.rejects(
    inputHandler(
      'fixture',
      config,
      h.ctx,
    )('elicitation/create', { message: 'Choose', requestedSchema: schema }),
    /not enabled/,
  );
  assert.equal(h.titles.length, 0);
  h.ctx.hasUI = true;
  const abort = new AbortController();
  h.ctx.ui.input = async () => {
    abort.abort();
    return '2';
  };
  await assert.rejects(
    inputHandler('fixture', config, h.ctx)(
      'elicitation/create',
      { message: 'Choose', requestedSchema: schema },
      abort.signal,
    ),
    /abort/i,
  );
  assert.equal(h.menus.length, 1);
});
