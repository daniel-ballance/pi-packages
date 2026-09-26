import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ObjectValue } from './headers.js';
const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;
export function validator(schema: ObjectValue) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error('Expected a JSON Schema object');
  if (Buffer.byteLength(JSON.stringify(schema)) > 128 * 1024)
    throw new Error('MCP schema exceeds 128 KiB');
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 4000 || depth > 40) throw new Error('MCP schema exceeds work budget');
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(schema, 0);
  const ajv =
    schema.$schema?.includes('2020-12') || !schema.$schema
      ? new Ajv2020({ strict: false, allErrors: false, validateFormats: true, inlineRefs: false })
      : new Ajv({ strict: false, allErrors: false, validateFormats: true, inlineRefs: false });
  addFormats(ajv);
  return ajv.compile(schema);
}
