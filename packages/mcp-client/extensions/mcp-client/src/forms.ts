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
  /password|passwd|passphrase|secret|token|authorization|credential|api[-_\s]?key|private[-_\s]?key/i;
function secretLabel(label: string): boolean {
  // Token counts/budgets are ordinary data, not credentials. Keep this exception narrow.
  const words = label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  if (/^(?:(?:max|min|maximum|minimum) )?tokens? (?:count|budget|limit)$/i.test(words))
    return false;
  return secretName.test(label);
}

/** A conservative heuristic, not a secret detector. Do not scan enum/default data as schemas. */
export function requestsSecrets(schema: ObjectValue): boolean {
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const shape = value as ObjectValue;
    if (
      shape.format === 'password' ||
      shape.writeOnly === true ||
      (typeof shape.title === 'string' && secretLabel(shape.title))
    )
      return true;
    for (const keyword of ['properties', 'patternProperties']) {
      const fields = shape[keyword];
      if (!fields || typeof fields !== 'object') continue;
      for (const [key, child] of Object.entries(fields)) {
        if (secretLabel(key)) return true;
        pending.push(child);
      }
    }
    for (const keyword of ['$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
      const children = shape[keyword];
      if (children && typeof children === 'object') pending.push(...Object.values(children));
    }
    for (const keyword of [
      'allOf',
      'anyOf',
      'oneOf',
      'prefixItems',
      'items',
      'additionalItems',
      'additionalProperties',
      'unevaluatedProperties',
      'unevaluatedItems',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
    ]) {
      const child = shape[keyword];
      pending.push(...(Array.isArray(child) ? child : [child]));
    }
  }
  return false;
}

/** Catch obvious secret keys even when an advanced schema allows arbitrary properties. */
export function hasSecretKeys(content: unknown): boolean {
  const pending = [content];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (secretLabel(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

/** A deliberately small UI subset; original-schema validation remains authoritative. */
export function canGuide(schema: ObjectValue): boolean {
  if (
    !schema ||
    requestsSecrets(schema) ||
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
      !secretLabel(key) &&
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
      options.signal?.throwIfAborted();
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
        options.signal?.throwIfAborted();
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
        options.signal?.throwIfAborted();
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

// Bound both the total review and each native select dialog. Never silently shorten data.
export const FORM_REVIEW_PAGE_CHARS = 512;
export const FORM_REVIEW_MAX_PAGES = 32;

/** Complete JSON at path $, with answers at $.content. ASCII escapes preserve every code unit. */
export function formResponsePages(
  content: ObjectValue,
): { response: ObjectValue; pages: string[] } | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify({ action: 'accept', content });
    if (serialized.length > FORM_REVIEW_PAGE_CHARS * FORM_REVIEW_MAX_PAGES) return undefined;
    serialized = serialized.replace(
      /[^\x20-\x7e]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    if (serialized.length > FORM_REVIEW_PAGE_CHARS * FORM_REVIEW_MAX_PAGES) return undefined;
  } catch {
    return undefined;
  }
  const pages: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += FORM_REVIEW_PAGE_CHARS)
    pages.push(serialized.slice(offset, offset + FORM_REVIEW_PAGE_CHARS));
  // Send the same snapshot that was reviewed, never a subsequently mutated draft.
  return { response: JSON.parse(serialized), pages };
}

export async function reviewFormResponse(
  ctx: ExtensionContext,
  name: string,
  content: ObjectValue,
  options: { signal?: AbortSignal; timeout: number },
): Promise<{ response?: ObjectValue; edit?: boolean }> {
  options.signal?.throwIfAborted();
  if (!ctx.hasUI) return {};
  const review = formResponsePages(content);
  if (!review) {
    ctx.ui.notify(
      `Answers are too large for complete review (maximum ${FORM_REVIEW_PAGE_CHARS * FORM_REVIEW_MAX_PAGES} escaped JSON characters). No answers were sent. Submit a smaller form.`,
      'warning',
    );
    return {};
  }
  for (const [index, page] of review.pages.entries()) {
    options.signal?.throwIfAborted();
    const last = index === review.pages.length - 1;
    const choice = await ctx.ui.select(
      `MCP ${displayText(name, 80)}: review answers before sending\nJSON path $ (complete response; answers at $.content)\nPage ${index + 1}/${review.pages.length}; characters ${index * FORM_REVIEW_PAGE_CHARS + 1}-${index * FORM_REVIEW_PAGE_CHARS + page.length}\n${page}\nConsecutive pages concatenate to the exact JSON response. Unicode/control characters are escaped, not removed. Edit answers re-enters all values.`,
      [last ? 'Send answers' : 'Next page', 'Edit answers', 'Cancel'],
      options,
    );
    options.signal?.throwIfAborted();
    if (choice === 'Edit answers') return { edit: true };
    if (last && choice === 'Send answers') return { response: review.response };
    if (last || choice !== 'Next page') return {};
  }
  return {};
}

/** Short previews for non-elicitation callers; never sufficient as form release review. */
export function formSummary(content: ObjectValue): string {
  return (
    Object.entries(content)
      .map(([key, value]) => `${displayText(key, 80)}: ${displayText(JSON.stringify(value), 160)}`)
      .join('\n') || '(No fields provided)'
  );
}
