import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canGuide,
  fillFields,
  requestsSecrets,
  hasSecretKeys,
} from '../extensions/mcp-client/src/forms.js';
import { inputHandler, withMcpDialog } from '../extensions/mcp-client/src/input.js';
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

test('guided forms are a bounded scalar subset; secrets and complex schemas are not guided', () => {
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
  assert.match(h.titles.at(-1)!, /review answers before sending/);
  assert.match(h.titles.at(-1)!, /"count":2/);
  assert.match(h.titles.at(-1)!, /"enabled":false/);
  assert.deepEqual(h.menus.at(-1), ['Send answers', 'Edit answers', 'Cancel']);
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
  const h = ui(['Provide JSON', 'Send answers'], ['{private-invalid-value', '{"name":"ok"}']);
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

const simple = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
};
const params = { message: 'Choose', requestedSchema: simple };

for (const path of ['Fill in fields', 'Provide JSON']) {
  test(`${path}: every valid draft requires review and editing replaces all answers`, async () => {
    const h = ui(
      [path, 'Edit answers', 'Send answers'],
      path === 'Fill in fields' ? ['1', '2'] : ['{"count":1}', '{"count":2}'],
    );
    const result = await inputHandler('fixture', config, h.ctx)('elicitation/create', params);
    assert.equal(result.action, 'accept');
    assert.deepEqual({ ...result.content }, { count: 2 });
    assert.equal(
      h.titles.filter((title) => title.includes('review answers before sending')).length,
      2,
    );
    assert.match(h.titles.at(-1)!, /"count":2/);
  });

  test(`${path}: review dismissal, unexpected responses and cancelled edits never release data`, async () => {
    for (const choice of [undefined, 'Cancel', 'unexpected', 'Edit answers']) {
      const h = ui([path, choice], path === 'Fill in fields' ? ['1'] : ['{"count":1}']);
      assert.deepEqual(await inputHandler('fixture', config, h.ctx)('elicitation/create', params), {
        action: 'cancel',
      });
    }
  });

  test(`${path}: editing has a finite budget and never silently sends the last draft`, async () => {
    const h = ui(
      [path, 'Edit answers', 'Edit answers', 'Edit answers'],
      path === 'Fill in fields' ? ['1', '2', '3'] : ['{"count":1}', '{"count":2}', '{"count":3}'],
    );
    assert.deepEqual(await inputHandler('fixture', config, h.ctx)('elicitation/create', params), {
      action: 'cancel',
    });
    assert.equal(h.menus.length, 4);
    assert.match(h.notices.at(-1)!, /three review rounds.*No answers were sent/);
  });

  test(`${path}: abort after initial choice, entry or final review prevents acceptance`, async () => {
    for (const abortAt of [1, 2, 3]) {
      const controller = new AbortController();
      const h = ui([path, 'Send answers'], path === 'Fill in fields' ? ['1'] : ['{"count":1}']);
      let calls = 0;
      for (const method of ['select', 'input']) {
        const original = h.ctx.ui[method];
        h.ctx.ui[method] = async (...args: unknown[]) => {
          const result = await original(...args);
          if (++calls === abortAt) controller.abort();
          return result;
        };
      }
      await assert.rejects(
        inputHandler('fixture', config, h.ctx)('elicitation/create', params, controller.signal),
        /abort/i,
      );
      assert.equal(calls, abortAt);
    }
  });
}

test('JSON full-schema validation failure retries and still requires review after editing', async () => {
  const requestedSchema = {
    type: 'object',
    properties: {},
    required: ['missing'],
  };
  const h = ui(
    ['Provide JSON', 'Edit answers', 'Send answers'],
    ['{}', '{"missing":"first"}', '{"missing":"second"}'],
  );
  const result = await inputHandler(
    'fixture',
    config,
    h.ctx,
  )('elicitation/create', { message: 'Choose', requestedSchema });
  assert.deepEqual(result, { action: 'accept', content: { missing: 'second' } });
  assert.equal(h.notices.length, 1);
  assert.equal(h.menus.filter((menu) => menu.includes('Send answers')).length, 2);
});

test('obvious secret schemas are rejected before any dialog, including JSON-only schemas', async () => {
  for (const requestedSchema of [
    { type: 'object', properties: { api_key: { type: 'string' } } },
    { type: 'object', properties: { opaque: { type: 'string', title: 'API key' } } },
    { type: 'object', properties: { opaque: { type: 'string', format: 'password' } } },
    { type: 'object', properties: { opaque: { type: 'string', writeOnly: true } } },
    { allOf: [{ type: 'object', properties: { accessToken: { type: 'string' } } }] },
    {
      type: 'object',
      properties: {
        details: {
          type: 'array',
          items: { type: 'object', properties: { password: { type: 'string' } } },
        },
      },
    },
    {
      type: 'object',
      properties: { value: { $ref: '#/$defs/private' } },
      $defs: { private: { type: 'string', writeOnly: true } },
    },
  ]) {
    const h = ui(['Provide JSON', 'Send answers'], ['{}']);
    await assert.rejects(
      inputHandler(
        'fixture',
        config,
        h.ctx,
      )('elicitation/create', { message: 'Choose', requestedSchema }),
      /must not request secrets/,
    );
    assert.equal(h.titles.length, 0);
  }
});

test('nonsecret complex data remains supported; enum/default data are not schema keywords', async () => {
  const requestedSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['password', 'token'], default: 'password' },
      details: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          writeOnly: { type: 'boolean' },
          format: { type: 'string' },
        },
      },
    },
  };
  const content = {
    kind: 'password',
    details: { title: 'report', writeOnly: true, format: 'password' },
  };
  assert.equal(requestsSecrets(requestedSchema), false);
  assert.equal(hasSecretKeys(content), false);
  const h = ui(['Provide JSON', 'Send answers'], [JSON.stringify(content)]);
  assert.deepEqual(
    await inputHandler(
      'fixture',
      config,
      h.ctx,
    )('elicitation/create', { message: 'Choose', requestedSchema }),
    { action: 'accept', content },
  );
});

test('nonsecret token counters remain eligible for guided and JSON entry', async () => {
  for (const key of ['tokenCount', 'token_budget', 'max-token-limit']) {
    const requestedSchema = { type: 'object', properties: { [key]: { type: 'integer' } } };
    assert.equal(canGuide(requestedSchema), true);
    const h = ui(['Provide JSON', 'Send answers'], [JSON.stringify({ [key]: 100 })]);
    assert.deepEqual(
      await inputHandler(
        'fixture',
        config,
        h.ctx,
      )('elicitation/create', { message: 'Choose', requestedSchema }),
      { action: 'accept', content: { [key]: 100 } },
    );
  }
});

// These shapes are identical in the official 2025-11-25 and 2026-07-28 schema.ts:
// https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts
// https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
// New enum controls are deferred; the JSON path must retain validation and final consent.
for (const [field, invalid, valid] of [
  [
    {
      type: 'string',
      oneOf: [
        { const: 'r', title: 'Red' },
        { const: 'g', title: 'Green' },
      ],
    },
    'invalid',
    'g',
  ],
  [
    { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['r', 'g'] } },
    [],
    ['r', 'g'],
  ],
  [
    {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: 'r', title: 'Red' },
          { const: 'g', title: 'Green' },
        ],
      },
    },
    ['invalid'],
    ['g'],
  ],
] as const) {
  test(`current-spec ${JSON.stringify(field)} retains the reviewed JSON path`, async () => {
    const requestedSchema = { type: 'object', properties: { color: field }, required: ['color'] };
    assert.equal(canGuide(requestedSchema), false);
    const h = ui(
      ['Provide JSON', 'Send answers'],
      [JSON.stringify({ color: invalid }), JSON.stringify({ color: valid })],
    );
    assert.deepEqual(
      await inputHandler(
        'fixture',
        config,
        h.ctx,
      )('elicitation/create', { message: 'Choose', requestedSchema }),
      { action: 'accept', content: { color: valid } },
    );
    assert.deepEqual(h.menus[0], ['Provide JSON', 'Decline']);
    assert.deepEqual(h.menus[1], ['Send answers', 'Edit answers', 'Cancel']);
    assert.equal(h.notices.length, 1);
  });
}

test('JSON cannot send obvious secret keys via additional properties or nested arrays', async () => {
  const h = ui(
    ['Provide JSON'],
    [
      '{"password":"DO-NOT-ECHO"}',
      '{"nested":[{"apiKey":"DO-NOT-ECHO"}]}',
      '{"auth":{"access_token":"DO-NOT-ECHO"}}',
    ],
  );
  assert.deepEqual(
    await inputHandler(
      'fixture',
      config,
      h.ctx,
    )('elicitation/create', { message: 'Choose', requestedSchema: { type: 'object' } }),
    { action: 'cancel' },
  );
  assert.equal(h.notices.length, 3);
  assert.doesNotMatch([...h.notices, ...h.titles].join('\n'), /DO-NOT-ECHO/);
  assert.equal(h.menus.length, 1);
});

test('JSON primitives are not accepted even when an advanced schema permits them', async () => {
  const h = ui(['Provide JSON', 'Send answers'], ['null', '[]', '42']);
  assert.deepEqual(
    await inputHandler(
      'fixture',
      config,
      h.ctx,
    )('elicitation/create', { message: 'Choose', requestedSchema: {} }),
    { action: 'cancel' },
  );
  assert.equal(h.menus.length, 1);
});

test('unknown elicitation modes fail closed without dialogs; omitted and form modes work', async () => {
  for (const mode of ['future', '', null, 1, false, {}]) {
    const h = ui(['Provide JSON', 'Send answers'], ['{"count":1}']);
    await assert.rejects(
      inputHandler('fixture', config, h.ctx)('elicitation/create', { ...params, mode }),
      (error: any) => error.code === -32602 && /Unknown elicitation mode/.test(error.message),
    );
    assert.equal(h.titles.length, 0);
  }
  const h = ui(['Provide JSON', 'Send answers'], ['{"count":1}']);
  assert.equal(
    (
      await inputHandler(
        'fixture',
        config,
        h.ctx,
      )('elicitation/create', { ...params, mode: 'form' })
    ).action,
    'accept',
  );
});

test('abort during optional skip or enum choice stops before another field dialog', async () => {
  for (const [shape, choice] of [
    [
      { type: 'object', properties: { optional: { type: 'string' }, next: { type: 'string' } } },
      'Skip',
    ],
    [
      {
        type: 'object',
        properties: { value: { type: 'boolean' }, next: { type: 'string' } },
        required: ['value'],
      },
      '1. true',
    ],
  ] as const) {
    const controller = new AbortController();
    const h = ui([], []);
    let calls = 0;
    h.ctx.ui.select = async () => {
      calls++;
      controller.abort();
      return choice;
    };
    await assert.rejects(
      fillFields(h.ctx, 'Choose', shape, { timeout: 1000, signal: controller.signal }),
      /abort/i,
    );
    assert.equal(calls, 1);
  }
});

test('a request cancelled while queued never opens a dialog and does not poison the queue', async () => {
  let release!: () => void;
  const blocked = withMcpDialog(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const h = ui(['Provide JSON', 'Send answers'], ['{"count":1}']);
  const controller = new AbortController();
  const queued = inputHandler('fixture', config, h.ctx)(
    'elicitation/create',
    params,
    controller.signal,
  );
  controller.abort();
  release();
  await blocked;
  await assert.rejects(queued, /abort/i);
  assert.equal(h.titles.length, 0);
  assert.equal(
    (await inputHandler('fixture', config, h.ctx)('elicitation/create', params)).action,
    'accept',
  );
});

test('URL mode requires an explicit choice and checks cancellation after selection and opening', async () => {
  const urlConfig = ServerSchema.parse({
    transport: 'stdio',
    command: 'unused',
    elicitationUrl: true,
  });
  const request = {
    mode: 'url',
    message: 'Continue',
    elicitationId: 'id',
    url: 'https://example.invalid/',
  };
  for (const choice of [undefined, 'Decline', 'unexpected', 'Open URL']) {
    const h = ui([choice], []);
    let opens = 0;
    assert.deepEqual(
      await inputHandler('fixture', urlConfig, h.ctx, undefined, async () => {
        opens++;
      })('elicitation/create', request),
      { action: choice === 'Open URL' ? 'accept' : choice === 'Decline' ? 'decline' : 'cancel' },
    );
    assert.equal(opens, choice === 'Open URL' ? 1 : 0);
  }
  for (const abortAt of ['select', 'open']) {
    const h = ui([], []);
    const controller = new AbortController();
    let opens = 0;
    h.ctx.ui.select = async () => {
      if (abortAt === 'select') controller.abort();
      return 'Open URL';
    };
    await assert.rejects(
      inputHandler('fixture', urlConfig, h.ctx, undefined, async () => {
        opens++;
        controller.abort();
      })('elicitation/create', request, controller.signal),
      /abort/i,
    );
    assert.equal(opens, abortAt === 'open' ? 1 : 0);
  }
});
