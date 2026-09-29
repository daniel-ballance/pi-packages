import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeHeader,
  headerBindings,
  parameterHeaders,
} from '../extensions/mcp-client/src/headers.js';

test('header values preserve Unicode, whitespace, controls and sentinel literals', () => {
  assert.equal(encodeHeader('us-west1'), 'us-west1');
  for (const value of ['世界', ' padded ', 'a\r\nb', '=?base64?literal?=']) {
    assert.equal(encodeHeader(value), `=?base64?${Buffer.from(value).toString('base64')}?=`);
  }
});

test('nested header extraction, null omission and safe integers', () => {
  const bindings = headerBindings({
    type: 'object',
    properties: {
      config: {
        type: 'object',
        properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
      },
      count: { type: 'integer', 'x-mcp-header': 'Count' },
    },
  });
  assert.deepEqual(parameterHeaders(bindings, { config: { region: 'a' }, count: 3 }), {
    'Mcp-Param-Region': 'a',
    'Mcp-Param-Count': '3',
  });
  assert.deepEqual(parameterHeaders(bindings, { config: null, count: null }), {});
  assert.throws(() => parameterHeaders(bindings, { count: 2 ** 53 }));
});

test('invalid annotations are rejected, not silently ignored', () => {
  for (const schema of [
    { properties: { a: { type: 'number', 'x-mcp-header': 'A' } } },
    { properties: { a: { type: 'string', 'x-mcp-header': 'bad\r\nheader' } } },
    {
      properties: {
        a: { type: 'string', 'x-mcp-header': 'A' },
        b: { type: 'string', 'x-mcp-header': 'a' },
      },
    },
    { oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] },
    { properties: { a: { items: { type: 'string', 'x-mcp-header': 'A' } } } },
  ])
    assert.throws(() => headerBindings(schema));
});
