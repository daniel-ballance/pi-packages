import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Peer } from '../extensions/mcp-client/src/peer.js';
import { ServerSchema } from '../extensions/mcp-client/src/config.js';
import { inputHandler, withMcpDialog } from '../extensions/mcp-client/src/input.js';
import {
  parseComputerUsePolicy,
  type ComputerUsePolicy,
  type ComputerUseApprovalDiagnostic,
} from '../extensions/mcp-client/src/computer-use-approval.js';

const policy: ComputerUsePolicy = {
  apps: ['com.apple.calculator'],
  operations: ['get_app_state', 'click', 'press_key'],
  persistence: 'session',
};
const config = ServerSchema.parse({ transport: 'stdio', command: 'unused', elicitation: true });
function request(): any {
  return {
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      connector_name: 'Computer Use',
      persist: ['session', 'always'],
      riskLevel: 'low',
      tool_name: 'get_app_state',
      tool_params: { app: 'com.apple.calculator' },
      tool_params_display: [{ display_name: 'DO-NOT-ECHO secret display', value: 'DO-NOT-ECHO' }],
    },
    message: 'Allow DO-NOT-ECHO?',
    mode: 'form',
    requestedSchema: { properties: {}, type: 'object' },
  };
}
function harness(
  choice: string | undefined = 'Allow for this session',
  selectedPolicy: ComputerUsePolicy | undefined = policy,
  lifetime?: AbortSignal,
) {
  const events: ComputerUseApprovalDiagnostic[] = [];
  const titles: string[] = [],
    menus: string[][] = [];
  const ctx: any = {
    hasUI: true,
    cwd: '/tmp',
    ui: {
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        menus.push(choices);
        return choice;
      },
      input: async () => {
        throw new Error('Generic input must not open');
      },
      notify: () => {
        throw new Error('No metadata notifications');
      },
    },
  };
  const handler = inputHandler(
    'raw-configured-server',
    config,
    ctx,
    undefined,
    undefined,
    undefined,
    selectedPolicy,
    (event) => events.push(event),
    lifetime,
  );
  return { handler, ctx, titles, menus, events };
}

test('strict bounded policy parser accepts only explicit session scope and verified operations', () => {
  assert.deepEqual(parseComputerUsePolicy(policy), policy);
  for (const invalid of [
    undefined,
    null,
    {},
    [],
    { ...policy, persistence: 'always' },
    { ...policy, autoAccept: true },
    { ...policy, apps: [] },
    { ...policy, operations: [] },
    { ...policy, apps: ['*'] },
    { ...policy, apps: ['com.apple.calculator\n'] },
    { ...policy, apps: ['x'.repeat(129) + '.app'] },
    { ...policy, apps: Array.from({ length: 17 }, (_, i) => `app.${i}`) },
    { ...policy, apps: ['com.apple.calculator', 'com.apple.calculator'] },
    { ...policy, operations: ['click', 'click'] },
    { ...policy, operations: ['open_url'] },
    { ...policy, operations: ['click', 'press_key', 'get_app_state', 'anything'] },
  ])
    assert.throws(
      () => parseComputerUsePolicy(invalid),
      /^Error: Invalid computer-use approval policy$/,
    );
});

for (const operation of policy.operations) {
  test(`human approval for ${operation} returns only the verified session response`, async () => {
    const h = harness();
    const params = request();
    params._meta.tool_name = operation;
    params._meta.display_name = 'DO-NOT-ECHO official system authority';
    const result = await h.handler('elicitation/create', params);
    assert.deepEqual(result, { action: 'accept', content: {}, _meta: { persist: 'session' } });
    assert.equal(h.titles.length, 1);
    assert.match(h.titles[0], /Configured server: "raw-configured-server"/);
    assert.match(h.titles[0], /App ID: "com.apple.calculator"/);
    assert.ok(h.titles[0].includes(`Operation: "${operation}"`));
    assert.match(h.titles[0], /Scope: this session only/);
    assert.deepEqual(h.menus[0], ['Allow for this session', 'Decline', 'Cancel']);
    assert.doesNotMatch(JSON.stringify([result, h.titles, h.menus]), /always|DO-NOT-ECHO/);
  });
}

test('decline, dismissal, cancellation and forged choices never return persistence or content', async () => {
  for (const choice of [
    'Decline',
    'Cancel',
    undefined,
    'Allow always',
    'accept',
    'Allow for this session ',
  ]) {
    const h = harness(choice);
    // Explicit undefined must override the helper's default parameter.
    h.ctx.ui.select = async () => choice;
    assert.deepEqual(await h.handler('elicitation/create', request()), {
      action: choice === 'Decline' ? 'decline' : 'cancel',
    });
  }
});

test('observed progress tokens are correlation metadata, never scope or approval', async () => {
  for (const progressToken of [0, 42, 'progress']) {
    const h = harness();
    const params = request();
    params._meta.progressToken = progressToken;
    assert.deepEqual(await h.handler('elicitation/create', params), {
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    });
    assert.equal(h.titles.length, 1);
  }
  for (const progressToken of [null, {}, [], true, Infinity]) {
    const h = harness();
    const params = request();
    params._meta.progressToken = progressToken;
    await assert.rejects(h.handler('elicitation/create', params), /does not match/);
    assert.equal(h.titles.length, 0);
  }
});

test('session-only offers are accepted without adding an unoffered scope', async () => {
  const h = harness();
  const params = request();
  params._meta.persist = ['session'];
  assert.deepEqual(await h.handler('elicitation/create', params), {
    action: 'accept',
    content: {},
    _meta: { persist: 'session' },
  });
});

test('human grants reuse only the disclosed configured operation subset for this app', async () => {
  const h = harness();
  assert.equal(h.events.length, 0);
  await h.handler('elicitation/create', request());
  for (const operation of policy.operations) {
    const params = request();
    params._meta.tool_name = operation;
    assert.deepEqual(await h.handler('elicitation/create', params), {
      action: 'accept',
      content: { source: 'computer-use-persisted-state' },
      _meta: { persist: 'session' },
    });
    assert.ok(h.titles[0].includes(JSON.stringify(operation)));
  }
  assert.match(h.titles[0], /on this connection/);
  assert.equal(h.titles.length, 1);
  assert.equal(h.events[0].source, 'human');
  assert.ok(h.events.slice(1).every((event) => event.source === 'session'));
});

test('other configured apps and separate handlers require new human consent', async () => {
  const scoped = { ...policy, apps: [...policy.apps, 'com.apple.TextEdit'] };
  const h = harness('Allow for this session', scoped);
  await h.handler('elicitation/create', request());
  const other = request();
  other._meta.tool_params.app = 'com.apple.TextEdit';
  await h.handler('elicitation/create', other);
  assert.equal(h.titles.length, 2);
  const fresh = harness('Allow for this session', scoped);
  await fresh.handler('elicitation/create', request());
  assert.equal(fresh.titles.length, 1);
});

test('concurrent queued eligible requests reuse one human grant', async () => {
  const h = harness();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => h.handler('elicitation/create', request())),
  );
  assert.equal(h.titles.length, 1);
  assert.deepEqual(results[0].content, {});
  assert.ok(
    results.slice(1).every((result) => result.content.source === 'computer-use-persisted-state'),
  );
});

test('non-approval choices never grant and dismissal is not diagnosed as denial', async () => {
  for (const choice of ['Decline', 'Cancel', undefined, 'forged']) {
    const h = harness();
    let prompts = 0;
    h.ctx.ui.select = async () => {
      prompts++;
      return choice;
    };
    await h.handler('elicitation/create', request());
    await h.handler('elicitation/create', request());
    assert.equal(prompts, 2);
    assert.equal(h.events[0].decision, choice === 'Decline' ? 'decline' : 'cancel');
    if (choice === undefined) assert.equal(h.events[0].reason, 'dismissed-or-timeout');
    h.ctx.ui.select = async () => {
      prompts++;
      return 'Allow for this session';
    };
    await h.handler('elicitation/create', request());
    assert.equal(prompts, 3);
  }
});

test('connection lifetime invalidates cached consent and suppresses pending acceptance', async () => {
  for (const pending of [false, true]) {
    const lifetime = new AbortController();
    const h = harness('Allow for this session', policy, lifetime.signal);
    if (pending)
      h.ctx.ui.select = async (_title: string, _choices: string[], options: any) => {
        lifetime.abort();
        assert.equal(options.signal.aborted, true);
        return 'Allow for this session';
      };
    if (pending) await assert.rejects(h.handler('elicitation/create', request()), /abort/i);
    else {
      await h.handler('elicitation/create', request());
      lifetime.abort();
    }
    await assert.rejects(h.handler('elicitation/create', request()), /abort/i);
    assert.equal(h.events.at(-1)?.decision, 'abort');
    assert.ok(!h.events.some((event) => event.source === 'session'));
    const fresh = harness();
    await fresh.handler('elicitation/create', request());
    assert.equal(fresh.titles.length, 1);
  }
});

test('pre-aborted lifetime and cancelled cached requests never accept', async () => {
  const lifetime = new AbortController();
  lifetime.abort();
  const closed = harness('Allow for this session', policy, lifetime.signal);
  await assert.rejects(closed.handler('elicitation/create', request()), /abort/i);
  assert.equal(closed.titles.length, 0);
  const h = harness();
  await h.handler('elicitation/create', request());
  await assert.rejects(h.handler('elicitation/create', request(), lifetime.signal), /abort/i);
  assert.equal(h.events.at(-1)?.decision, 'abort');
});

test('request abort during a prompt never stores a late grant', async () => {
  const h = harness();
  const abort = new AbortController();
  h.ctx.ui.select = async () => {
    abort.abort();
    return 'Allow for this session';
  };
  await assert.rejects(h.handler('elicitation/create', request(), abort.signal), /abort/i);
  h.ctx.ui.select = async () => 'Decline';
  assert.deepEqual(await h.handler('elicitation/create', request()), { action: 'decline' });
});

test('diagnostics callback failure cannot grant, deny, or leak into the response', async () => {
  const h = harness('Decline');
  const handler = inputHandler(
    'raw',
    config,
    h.ctx,
    undefined,
    undefined,
    undefined,
    policy,
    () => {
      throw new Error('DO-NOT-ECHO diagnostic failure');
    },
  );
  assert.deepEqual(await handler('elicitation/create', request()), { action: 'decline' });
  h.ctx.ui.select = async () => 'Allow for this session';
  assert.deepEqual(await handler('elicitation/create', request()), {
    action: 'accept',
    content: {},
    _meta: { persist: 'session' },
  });
  assert.deepEqual(await handler('elicitation/create', request()), {
    action: 'accept',
    content: { source: 'computer-use-persisted-state' },
    _meta: { persist: 'session' },
  });
});

test('thrown UI errors propagate with bounded safe diagnostics and no grant', async () => {
  const h = harness();
  const error = new Error('DO-NOT-ECHO raw metadata secret');
  h.ctx.ui.select = async () => {
    throw error;
  };
  await assert.rejects(h.handler('elicitation/create', request()), (caught) => caught === error);
  assert.deepEqual(h.events, [
    {
      app: 'com.apple.calculator',
      operation: 'get_app_state',
      decision: 'reject',
      source: 'human',
      reason: 'error',
    },
  ]);
  h.ctx.ui.select = async () => 'Decline';
  assert.deepEqual(await h.handler('elicitation/create', request()), { action: 'decline' });
});

const mutations: [string, (params: any) => void][] = [
  ['missing metadata', (p) => delete p._meta],
  ['null metadata', (p) => (p._meta = null)],
  ['array metadata', (p) => (p._meta = [])],
  ['missing kind', (p) => delete p._meta.codex_approval_kind],
  ['wrong kind', (p) => (p._meta.codex_approval_kind = 'other')],
  ['wrong connector', (p) => (p._meta.connector_id = 'other')],
  ['missing connector', (p) => delete p._meta.connector_id],
  ['wrong connector name', (p) => (p._meta.connector_name = 'Official')],
  ['wrong app', (p) => (p._meta.tool_params.app = 'com.apple.mail')],
  ['missing app', (p) => delete p._meta.tool_params.app],
  ['wrong op', (p) => (p._meta.tool_name = 'launch_app')],
  ['missing op', (p) => delete p._meta.tool_name],
  ['unoffered session', (p) => (p._meta.persist = ['always'])],
  ['unknown persistence', (p) => (p._meta.persist = ['session', 'forever'])],
  ['duplicate persistence', (p) => (p._meta.persist = ['session', 'session'])],
  ['missing persistence', (p) => delete p._meta.persist],
  ['high risk', (p) => (p._meta.riskLevel = 'high')],
  ['warning subtitle', (p) => (p._meta.subtitle = 'DO-NOT-ECHO')],
  ['missing risk', (p) => delete p._meta.riskLevel],
  ['unknown metadata', (p) => (p._meta.permission = 'always')],
  ['missing display list', (p) => delete p._meta.tool_params_display],
  ['unknown top-level', (p) => (p.permission = 'always')],
  ['imported grant', (p) => (p.content = { source: 'computer-use-persisted-state' })],
  ['URL mode', (p) => (p.mode = 'url')],
  ['missing mode', (p) => delete p.mode],
  ['missing message', (p) => delete p.message],
  ['missing schema', (p) => delete p.requestedSchema],
  ['nonempty schema', (p) => (p.requestedSchema.properties = { persist: { type: 'string' } })],
  ['extra schema keyword', (p) => (p.requestedSchema.additionalProperties = true)],
  ['array properties', (p) => (p.requestedSchema.properties = [])],
  ['secret parameter', (p) => (p._meta.tool_params.password = 'DO-NOT-ECHO')],
  ['oversized request', (p) => (p.message = 'DO-NOT-ECHO'.repeat(6000))],
];
for (const [label, mutate] of mutations) {
  test(`${label} is rejected without generic form fallback or metadata leakage`, async () => {
    const h = harness();
    const params = request();
    mutate(params);
    await assert.rejects(h.handler('elicitation/create', params), (e: any) => {
      assert.equal(e.code, -32602);
      assert.doesNotMatch(e.message, /DO-NOT-ECHO|always|com.apple.mail/);
      return true;
    });
    assert.equal(h.titles.length, 0);
    // An existing grant must never bypass these same checks.
    await h.handler('elicitation/create', request());
    await assert.rejects(h.handler('elicitation/create', params), /does not match/);
    assert.equal(h.titles.length, 1);
    assert.doesNotMatch(JSON.stringify(h.events), /DO-NOT-ECHO|com.apple.mail/);
  });
}

test('approval markers without a policy fail closed, even on URL requests', async () => {
  const h = harness();
  const handler = inputHandler('arbitrary-server-name', config, h.ctx);
  for (const mode of ['form', 'url']) {
    const params = request();
    params.mode = mode;
    await assert.rejects(handler('elicitation/create', params), /not enabled/);
  }
  await assert.rejects(
    inputHandler(
      'computer-use',
      config,
      h.ctx,
    )('elicitation/create', {
      message: 'Allow?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
    }),
    /not enabled/,
  );
  assert.equal(h.titles.length, 0);
});

test('configured operation subset is authoritative and policy is snapshotted', async () => {
  const restricted = { ...policy, operations: ['get_app_state'] };
  const h = harness('Allow for this session', restricted);
  await h.handler('elicitation/create', request());
  assert.match(h.titles[0], /Allowed operations for this app: "get_app_state"/);
  assert.doesNotMatch(h.titles[0], /"click"/);
  restricted.operations.push('click');
  const params = request();
  params._meta.tool_name = 'click';
  await assert.rejects(h.handler('elicitation/create', params), /does not match/);
  assert.equal(h.titles.length, 1);
});

test('headless and disabled elicitation reject without UI', async () => {
  const h = harness();
  h.ctx.hasUI = false;
  await assert.rejects(h.handler('elicitation/create', request()), /not enabled/);
  h.ctx.hasUI = true;
  const handler = inputHandler(
    'raw',
    { ...config, elicitation: false },
    h.ctx,
    undefined,
    undefined,
    undefined,
    policy,
  );
  await assert.rejects(handler('elicitation/create', request()), /not enabled/);
  assert.equal(h.titles.length, 0);
});

test('abort during selection suppresses a late human acceptance', async () => {
  const h = harness();
  const abort = new AbortController();
  h.ctx.ui.select = async () => {
    abort.abort();
    return 'Allow for this session';
  };
  await assert.rejects(h.handler('elicitation/create', request(), abort.signal), /abort/i);
});

test('queued cancelled approval opens no dialog; later requests still require approval', async () => {
  let release!: () => void;
  const blocked = withMcpDialog(() => new Promise<void>((resolve) => (release = resolve)));
  await Promise.resolve();
  const h = harness();
  const abort = new AbortController();
  const pending = h.handler('elicitation/create', request(), abort.signal);
  abort.abort();
  release();
  await blocked;
  await assert.rejects(pending, /abort/i);
  assert.equal(h.titles.length, 0);
  await h.handler('elicitation/create', request());
  assert.equal(h.titles.length, 1);
});

test('context cancellation and timeout during selection suppress late acceptance', async () => {
  for (const reason of ['context', 'timeout']) {
    const h = harness();
    const abort = new AbortController();
    h.ctx.signal = abort.signal;
    h.ctx.ui.select = async () => {
      if (reason === 'context') abort.abort();
      else await new Promise((resolve) => setTimeout(resolve, 30));
      return 'Allow for this session';
    };
    const handler = inputHandler(
      'raw',
      { ...config, timeout: 10 },
      h.ctx,
      undefined,
      undefined,
      undefined,
      policy,
    );
    await assert.rejects(handler('elicitation/create', request()), /abort|timeout/i);
  }
});

test('normal legacy MCP elicitation response preserves session metadata on the wire', async () => {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message) {
      sent.push(message);
    },
  };
  const peer = new Peer(transport, { elicitation: { form: {} } });
  peer.version = '2025-11-25';
  const h = harness();
  peer.oninput = h.handler;
  await peer.start();
  try {
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 'approval',
      method: 'elicitation/create',
      params: request(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [
      {
        jsonrpc: '2.0',
        id: 'approval',
        result: { action: 'accept', content: {}, _meta: { persist: 'session' } },
      },
    ]);
    assert.equal(h.titles.length, 1);
  } finally {
    await peer.close();
  }
});

test('normal Current MRTR retains session metadata without fabricating a request', async () => {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message) {
      sent.push(message);
      if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) return;
      const responses = message.params?.inputResponses as any;
      if (!responses) {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'input_required',
            requestState: 'opaque-approval-state',
            inputRequests: { approval: { method: 'elicitation/create', params: request() } },
          },
        });
      } else {
        assert.deepEqual(responses.approval, {
          action: 'accept',
          content: {},
          _meta: { persist: 'session' },
        });
        assert.equal(message.params?.requestState, 'opaque-approval-state');
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { resultType: 'complete' } });
      }
    },
  };
  const peer = new Peer(transport, { elicitation: { form: {} } });
  const h = harness();
  peer.oninput = h.handler;
  await peer.start();
  try {
    await peer.request('tools/call', { name: 'get_app_state' });
    assert.equal(sent.length, 2);
    assert.equal(h.titles.length, 1);
  } finally {
    await peer.close();
  }
});

test('timeout covering queue residence cannot produce late approval', async () => {
  let release!: () => void;
  const blocked = withMcpDialog(() => new Promise<void>((resolve) => (release = resolve)));
  await Promise.resolve();
  const h = harness();
  const handler = inputHandler(
    'raw',
    { ...config, timeout: 10 },
    h.ctx,
    undefined,
    undefined,
    undefined,
    policy,
  );
  const pending = handler('elicitation/create', request());
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await blocked;
  await assert.rejects(pending, /timeout/i);
  assert.equal(h.titles.length, 0);
});

test('expired queued approval cannot win a race with a delayed timeout callback', async () => {
  let release!: () => void;
  const blocked = withMcpDialog(() => new Promise<void>((resolve) => (release = resolve)));
  await Promise.resolve();
  const h = harness();
  const handler = inputHandler(
    'raw',
    { ...config, timeout: 10 },
    h.ctx,
    undefined,
    undefined,
    undefined,
    policy,
    (event) => h.events.push(event),
  );
  const pending = handler('elicitation/create', request());
  // Simulate a descheduled event loop. Release the queue in this turn, before
  // overdue timer callbacks can run; its promise continuations run first.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  release();
  await blocked;
  await assert.rejects(pending, /timeout/i);
  assert.equal(h.titles.length, 0);
  assert.equal(h.events.at(-1)?.decision, 'abort');
  await handler('elicitation/create', request());
  assert.equal(h.titles.length, 1);
  assert.ok(!h.events.some((event) => event.source === 'session'));
});

test('expired selection cannot store a grant before a delayed timeout callback', async () => {
  const h = harness();
  h.ctx.ui.select = async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    return 'Allow for this session';
  };
  const handler = inputHandler(
    'raw',
    { ...config, timeout: 10 },
    h.ctx,
    undefined,
    undefined,
    undefined,
    policy,
    (event) => h.events.push(event),
  );
  await assert.rejects(handler('elicitation/create', request()), /timeout/i);
  assert.equal(h.events.at(-1)?.decision, 'abort');
  h.ctx.ui.select = async () => 'Decline';
  assert.deepEqual(await handler('elicitation/create', request()), { action: 'decline' });
  assert.ok(!h.events.some((event) => event.source === 'session'));
});
