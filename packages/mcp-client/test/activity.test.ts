import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpActivity } from '../src/activity.js';

function harness() {
  const statuses = new Map<string, string>([
    ['other-extension', 'untouched'],
    ['mcp-client', 'health warning'],
  ]);
  const ctx: any = {
    hasUI: true,
    ui: {
      theme: { fg: (_: string, text: string) => text },
      setStatus: (key: string, value?: string) =>
        value === undefined ? statuses.delete(key) : statuses.set(key, value),
    },
  };
  return { ctx, statuses, activity: new McpActivity(() => ctx) };
}

test('activity is delayed, aggregates parallel work and clears only its own status', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const { activity, statuses } = harness();
  const quick = activity.begin('quick');
  t.mock.timers.tick(1000);
  quick();
  assert.equal(statuses.has('mcp-activity'), false);
  const finishA = activity.begin('server-a · connecting');
  const finishB = activity.begin('server-b · refreshing tools');
  t.mock.timers.tick(1999);
  assert.equal(statuses.has('mcp-activity'), false);
  t.mock.timers.tick(1);
  assert.match(statuses.get('mcp-activity')!, /server-a · connecting · 2s \(\+1\)/);
  finishA();
  finishA();
  assert.match(statuses.get('mcp-activity')!, /server-b · refreshing tools · 2s$/);
  finishB();
  assert.equal(statuses.has('mcp-activity'), false);
  assert.equal(statuses.get('other-extension'), 'untouched');
  assert.equal(statuses.get('mcp-client'), 'health warning');
  t.mock.timers.tick(10000);
  assert.equal(statuses.has('mcp-activity'), false);
  activity.clear();
});

test('shutdown and failures clear activity; headless runs do not create status', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const { activity, statuses, ctx } = harness();
  const finish = activity.begin('server\x1b[31m\nconnecting');
  t.mock.timers.tick(2000);
  assert.doesNotMatch(statuses.get('mcp-activity')!, /\x1b|\n/);
  activity.clear();
  finish();
  t.mock.timers.tick(4000);
  assert.equal(statuses.has('mcp-activity'), false);
  await assert.rejects(
    activity.run('failure', async () => {
      t.mock.timers.tick(3000);
      throw new Error('expected');
    }),
  );
  assert.equal(statuses.has('mcp-activity'), false);
  ctx.hasUI = false;
  const stop = activity.begin('headless');
  t.mock.timers.tick(3000);
  stop();
  assert.equal(statuses.has('mcp-activity'), false);
});
