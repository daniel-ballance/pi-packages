import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formResponsePages,
  reviewFormResponse,
  FORM_REVIEW_PAGE_CHARS,
  FORM_REVIEW_MAX_PAGES,
} from '../extensions/mcp-client/src/forms.js';
import { inputHandler } from '../extensions/mcp-client/src/input.js';
import { ServerSchema } from '../extensions/mcp-client/src/config.js';

const options = { timeout: 1000 };
function harness(choices: (string | undefined)[] = []) {
  const titles: string[] = [],
    menus: string[][] = [],
    notices: string[] = [];
  const ctx: any = {
    hasUI: true,
    cwd: '/tmp',
    ui: {
      select: async (title: string, menu: string[]) => {
        titles.push(title);
        menus.push(menu);
        return choices.shift();
      },
      notify: (message: string) => notices.push(message),
    },
  };
  return { ctx, titles, menus, notices };
}

test('pages preserve the entire response, paths, long keys, nested data and invisible code units', () => {
  const content = {
    ['long key '.repeat(70)]: {
      nested: [
        '  whitespace\t\r\n',
        '\x1b[2J\u202e\u2066\u200b😄',
        'z'.repeat(1900) + 'EXACT-TAIL',
      ],
    },
    empty: {},
    false: false,
    zero: 0,
    list: [],
  };
  const review = formResponsePages(content)!;
  assert.ok(review.pages.length > 1);
  assert.ok(
    review.pages.every(
      (page) => page.length <= FORM_REVIEW_PAGE_CHARS && /^[\x20-\x7e]+$/.test(page),
    ),
  );
  assert.deepEqual(JSON.parse(review.pages.join('')), { action: 'accept', content });
  assert.deepEqual(review.response, { action: 'accept', content });
  assert.match(review.pages.join(''), /EXACT-TAIL/);
  assert.match(review.pages.join(''), /\\u202e/);
});

test('single page retains the existing final choices but shows complete serialized response', async () => {
  const content = { count: 2 };
  const h = harness(['Send answers']);
  assert.deepEqual(await reviewFormResponse(h.ctx, 'raw', content, options), {
    response: { action: 'accept', content },
  });
  assert.deepEqual(h.menus, [['Send answers', 'Edit answers', 'Cancel']]);
  assert.match(h.titles[0], /JSON path \$ .*answers at \$\.content/);
  assert.ok(h.titles[0].includes(JSON.stringify({ action: 'accept', content })));
  assert.doesNotMatch(h.titles[0], /Preview only|shortened/);
});

test('every chunk is reviewed in order; only final page offers send', async () => {
  const content = { value: 'x'.repeat(1400) + 'FINAL-TAIL' };
  const review = formResponsePages(content)!;
  const h = harness([...review.pages.slice(1).map(() => 'Next page'), 'Send answers']);
  assert.deepEqual(await reviewFormResponse(h.ctx, 'raw', content, options), {
    response: review.response,
  });
  assert.equal(h.titles.length, review.pages.length);
  review.pages.forEach((page, i) => {
    assert.ok(h.titles[i].includes(`\n${page}\n`));
    assert.ok(h.titles[i].includes(`Page ${i + 1}/${review.pages.length}`));
    assert.equal(h.menus[i][0], i === review.pages.length - 1 ? 'Send answers' : 'Next page');
  });
});

test('forged send on an intermediate page, dismissal or cancellation sends nothing', async () => {
  for (const choice of ['Send answers', 'Cancel', undefined, 'unexpected']) {
    const h = harness([choice]);
    assert.deepEqual(
      await reviewFormResponse(h.ctx, 'raw', { value: 'x'.repeat(1500) }, options),
      {},
    );
    assert.equal(h.titles.length, 1);
  }
});

test('edits from a later page discard the whole previous draft and restart review', async () => {
  const h = harness(['Provide JSON', 'Next page', 'Edit answers', 'Send answers']);
  const drafts = [JSON.stringify({ value: 'x'.repeat(1500) }), '{"value":"replacement"}'];
  h.ctx.ui.input = async () => drafts.shift();
  const config = ServerSchema.parse({ transport: 'stdio', command: 'unused', elicitation: true });
  assert.deepEqual(
    await inputHandler(
      'raw',
      config,
      h.ctx,
    )('elicitation/create', {
      message: 'Choose',
      requestedSchema: { type: 'object', properties: { value: { type: 'string' } } },
    }),
    { action: 'accept', content: { value: 'replacement' } },
  );
  assert.match(h.titles.at(-1)!, /Page 1\/1/);
  assert.match(h.titles.at(-1)!, /replacement/);
});

test('oversized serialized or escaped data fail closed with a value-free explanation', async () => {
  for (const value of ['PRIVATE'.repeat(3000), '\u202e'.repeat(3000)]) {
    const content = { value };
    assert.equal(formResponsePages(content), undefined);
    const h = harness(['Send answers']);
    assert.deepEqual(await reviewFormResponse(h.ctx, 'raw', content, options), {});
    assert.equal(h.titles.length, 0);
    assert.match(h.notices[0], /too large for complete review.*No answers were sent/);
    assert.doesNotMatch(h.notices[0], /PRIVATE|\u202e/);
  }
  const prefixLength = JSON.stringify({ action: 'accept', content: { value: '' } }).length;
  assert.equal(
    formResponsePages({
      value: 'x'.repeat(FORM_REVIEW_PAGE_CHARS * FORM_REVIEW_MAX_PAGES - prefixLength),
    })?.pages.length,
    FORM_REVIEW_MAX_PAGES,
  );
  assert.equal(
    formResponsePages({
      value: 'x'.repeat(FORM_REVIEW_PAGE_CHARS * FORM_REVIEW_MAX_PAGES - prefixLength + 1),
    }),
    undefined,
  );
});

test('mutation during review cannot change the sent snapshot', async () => {
  const content = { value: 'reviewed' };
  const h = harness();
  h.ctx.ui.select = async () => {
    content.value = 'not reviewed';
    return 'Send answers';
  };
  assert.deepEqual(await reviewFormResponse(h.ctx, 'raw', content, options), {
    response: { action: 'accept', content: { value: 'reviewed' } },
  });
});

test('abort between pages or after final send cannot release a response', async () => {
  for (const content of [{ value: 'x'.repeat(1500) }, { value: 'short' }]) {
    const h = harness();
    const abort = new AbortController();
    h.ctx.ui.select = async () => {
      abort.abort();
      return content.value.length > 100 ? 'Next page' : 'Send answers';
    };
    await assert.rejects(
      reviewFormResponse(h.ctx, 'raw', content, { ...options, signal: abort.signal }),
      /abort/i,
    );
  }
});
