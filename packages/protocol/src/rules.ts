/**
 * Strict rules shared by the orchestration and daemon wire validators. Each rule
 * carries the JSON Schema fragment it enforces, so generated schemas derive from the
 * validator definitions. Internal to the package; not exported from the index.
 */
import { CONTROL_FREE_PATTERN, NONBLANK_PATTERN, schemaRef, UTC_TIMESTAMP_PATTERN, type JsonSchema } from './jsonSchema.js';
import { isUtcTimestamp, RUNTIME_ID_PATTERN } from './validate.js';

export type Check = (value: unknown, path: string, errors: string[]) => void;
export interface Rule { check: Check; schema: JsonSchema; optional?: true }
export const fail = (path: string, message: string, errors: string[]) => { errors.push(`${path}: ${message}.`); };
export const rule = (check: Check, schema: JsonSchema): Rule => ({ check, schema });
export const optional = (field: Rule): Rule => ({ ...field, optional: true });
/** Same check, published under a named `$defs` entry (or with extra schema keywords). */
export const withSchema = (field: Rule, schema: JsonSchema): Rule => ({ ...field, schema });
export const literal = (expected: string | number | boolean) => rule((value, path, errors) => {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`, errors);
}, { const: expected });
const textSchema = (max: number): JsonSchema => ({ type: 'string', maxLength: max, pattern: CONTROL_FREE_PATTERN, allOf: [{ pattern: NONBLANK_PATTERN }] });
export const text = (max: number) => rule((value, path, errors) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail(path, `expected nonempty single-line text of at most ${max} characters`, errors);
}, textSchema(max));
export const label = withSchema(text(2_000), schemaRef('Label'));
export const identifier = withSchema(text(200), schemaRef('Identifier'));
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const uuid = rule((value, path, errors) => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(path, 'expected a lowercase UUID', errors);
}, schemaRef('Uuid'));
export const digest = rule((value, path, errors) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail(path, 'expected a lowercase SHA-256 digest', errors);
}, schemaRef('Sha256Digest'));
export const runtimeId = rule((value, path, errors) => {
  if (typeof value !== 'string' || !RUNTIME_ID_PATTERN.test(value)) fail(path, 'expected a lowercase adapter or engine identifier', errors);
}, schemaRef('RuntimeId'));
export const timestamp = rule((value, path, errors) => { if (!isUtcTimestamp(value)) fail(path, 'expected a real UTC timestamp', errors); }, schemaRef('UtcTimestamp'));
export const number = (min: number, integer = false, max = Number.MAX_SAFE_INTEGER) => rule((value, path, errors) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(path, `expected ${integer ? 'a safe integer' : 'a finite number'} between ${min} and ${max}`, errors);
}, { type: integer ? 'integer' : 'number', minimum: min, maximum: max });
export const count = number(0, true);
export const positive = number(1, true);
export const nonnegative = number(0);
export const boolean = rule((value, path, errors) => { if (typeof value !== 'boolean') fail(path, 'expected a boolean', errors); }, { type: 'boolean' });
export const enumeration = (values: readonly string[]) => rule((value, path, errors) => {
  if (typeof value !== 'string' || !values.includes(value)) fail(path, `expected one of ${values.join(', ')}`, errors);
}, { type: 'string', enum: [...values] });
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function object(fields: Record<string, Rule>): Rule {
  const required = Object.entries(fields).filter(([, field]) => !field.optional).map(([key]) => key);
  return rule((value, path, errors) => {
    if (!isPlainObject(value)) { fail(path, 'expected a plain object', errors); return; }
    for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.hasOwn(fields, key)) fail(`${path}.${String(key)}`, 'unknown field', errors);
    for (const [key, field] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) { if (!field.optional) fail(`${path}.${key}`, 'required field', errors); }
      else field.check(value[key], `${path}.${key}`, errors);
    }
  }, { type: 'object', additionalProperties: false, ...(required.length ? { required } : {}), properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])) });
}
export const array = (itemRule: Rule, unique = false, min = 0, max = 1_000) => rule((value, path, errors) => {
  if (!Array.isArray(value) || value.length > max || value.length < min) { fail(path, `expected an array with ${min} to ${max} items`, errors); return; }
  if (unique && new Set(value).size !== value.length) fail(path, 'duplicate values', errors);
  for (let i = 0; i < value.length; i++) itemRule.check(value[i], `${path}[${i}]`, errors);
}, { type: 'array', ...(min ? { minItems: min } : {}), maxItems: max, ...(unique ? { uniqueItems: true } : {}), items: itemRule.schema });

/** Named primitives referenced by the rules above. Lengths count UTF-16 code units in the validators. */
export const PRIMITIVE_SCHEMA_DEFS: Readonly<Record<string, JsonSchema>> = {
  Uuid: { type: 'string', description: 'Lowercase RFC 9562 UUID, versions 1-8.', pattern: UUID_PATTERN.source },
  Sha256Digest: { type: 'string', description: 'Lowercase hexadecimal SHA-256 digest.', pattern: DIGEST_PATTERN.source },
  RuntimeId: { type: 'string', description: 'Lowercase adapter or engine identifier.', pattern: RUNTIME_ID_PATTERN.source },
  UtcTimestamp: { type: 'string', description: 'UTC instant YYYY-MM-DDTHH:mm:ss[.sss]Z on a real calendar date.', pattern: UTC_TIMESTAMP_PATTERN },
  Identifier: { description: 'Nonblank text without control characters, at most 200 UTF-16 code units.', ...textSchema(200) },
  Label: { description: 'Nonblank text without control characters, at most 2000 UTF-16 code units.', ...textSchema(2_000) },
};
