import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ObjectValue } from './headers.js';
const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;
export function validator(schema: ObjectValue) {
  const ajv =
    schema.$schema?.includes('2020-12') || !schema.$schema
      ? new Ajv2020({ strict: false, allErrors: true, validateFormats: true })
      : new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
