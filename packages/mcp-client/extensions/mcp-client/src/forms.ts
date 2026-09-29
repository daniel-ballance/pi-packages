import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ObjectValue } from './headers.js';
import { displayText } from './diagnostics.js';
import { validator, validationIssue } from './validation.js';

const rootKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  '$schema',
]);
const fieldKeys = new Set([
  'type',
  'title',
  'description',
  'default',
  'enum',
  'enumNames',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
]);
const secretName =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|private[-_]?key/i;

/** A deliberately small UI subset; original-schema validation remains authoritative. */
export function canGuide(schema: ObjectValue): boolean {
  if (
    !schema ||
    schema.type !== 'object' ||
    Object.keys(schema).some((key) => !rootKeys.has(key)) ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  )
    return false;
  const fields = Object.entries(schema.properties);
  if (
    fields.length > 16 ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key: unknown) => typeof key !== 'string' || !Object.hasOwn(schema.properties, key),
        )))
  )
    return false;
  return fields.every(([key, field]) => {
    const shape = field as ObjectValue;
    return (
      !secretName.test(key) &&
      shape &&
      typeof shape === 'object' &&
      !Array.isArray(shape) &&
      Object.keys(shape).every((key) => fieldKeys.has(key)) &&
      shape.format !== 'password' &&
      (shape.title === undefined || typeof shape.title === 'string') &&
      (shape.description === undefined || typeof shape.description === 'string') &&
      ['string', 'number', 'integer', 'boolean'].includes(shape.type) &&
      (shape.enum === undefined ||
        (Array.isArray(shape.enum) &&
          shape.enum.length > 0 &&
          shape.enum.length <= 40 &&
          shape.enum.every((value: unknown) =>
            ['string', 'number', 'boolean'].includes(typeof value),
          )))
    );
  });
}

export async function fillFields(
  ctx: ExtensionContext,
  title: string,
  schema: ObjectValue,
  options: { signal?: AbortSignal; timeout: number },
): Promise<ObjectValue | undefined> {
  if (!ctx.hasUI || !canGuide(schema)) return undefined;
  const fields = Object.entries(schema.properties) as [string, ObjectValue][];
  const content: ObjectValue = Object.create(null);
  for (const [index, [key, shape]] of fields.entries()) {
    const required = schema.required?.includes(key) === true;
    const label = `${displayText(title, 120)} · ${index + 1}/${fields.length}\n${displayText(shape.title ?? key, 120)} (${displayText(key, 80)}, ${required ? 'required' : 'optional'})${shape.description ? `\n${displayText(shape.description)}` : ''}`;
    options.signal?.throwIfAborted();
    if (!required) {
      const choice = await ctx.ui.select(label, ['Provide value', 'Skip'], options);
      if (choice === undefined) return undefined;
      if (choice === 'Skip') continue;
      if (choice !== 'Provide value') return undefined;
    }
    const validate = validator(shape);
    let accepted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      let value: unknown;
      const values = shape.enum ?? (shape.type === 'boolean' ? [true, false] : undefined);
      if (values) {
        const choices = values.map(
          (value: unknown, i: number) => `${i + 1}. ${displayText(JSON.stringify(value), 120)}`,
        );
        const choice = await ctx.ui.select(label, choices, options);
        if (choice === undefined) return undefined;
        const selected = choices.indexOf(choice);
        if (selected < 0) return undefined;
        value = values[selected];
      } else {
        const hints = [
          shape.type,
          shape.minimum !== undefined ? `minimum ${shape.minimum}` : '',
          shape.maximum !== undefined ? `maximum ${shape.maximum}` : '',
          shape.maxLength !== undefined ? `max length ${shape.maxLength}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        const entered = await ctx.ui.input(`${label}\n${hints}`, 'Enter a value', options);
        if (entered === undefined) return undefined;
        value = shape.type === 'string' ? entered : entered.trim() ? Number(entered) : NaN;
      }
      options.signal?.throwIfAborted();
      const finite = typeof value !== 'number' || Number.isFinite(value);
      if (finite && validate(value)) {
        content[key] = value;
        accepted = true;
        break;
      }
      ctx.ui.notify(
        `${displayText(key, 80)}: ${finite ? validationIssue(validate).replace('(root): ', '') : 'enter a finite number'}. ${attempt < 2 ? `Try again (${2 - attempt} attempts left).` : 'Form cancelled after three invalid attempts.'}`,
        'warning',
      );
    }
    if (!accepted) return undefined;
  }
  options.signal?.throwIfAborted();
  return content;
}

export function formSummary(content: ObjectValue): string {
  return (
    Object.entries(content)
      .map(([key, value]) => `${displayText(key, 80)}: ${displayText(JSON.stringify(value), 160)}`)
      .join('\n') || '(No fields provided)'
  );
}
