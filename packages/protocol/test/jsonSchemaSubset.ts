/**
 * Minimal JSON Schema (draft 2020-12) validator for exactly the keywords the protocol
 * generator emits. It throws on any other keyword, so a new keyword cannot be
 * silently ignored by the parity tests. Patterns use ECMA-262 with the `u` flag.
 */
import type { JsonSchema } from '../src/index.js';

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', '$defs']);
export const SUPPORTED_KEYWORDS = new Set([
  ...ANNOTATIONS, '$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'properties', 'required', 'additionalProperties',
  'dependentRequired', 'allOf', 'oneOf', 'not', 'if', 'then',
]);

const patterns = new Map<string, RegExp>();
const pattern = (source: string) => patterns.get(source) ?? patterns.set(source, new RegExp(source, 'u')).get(source)!;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return a === b;
}
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: throw new Error(`Unsupported type ${type}`);
  }
}

/** True when `value` is valid against `schema`; `$ref` resolves only to `#/$defs/<name>` of `root`. */
export function validateJsonSchema(schema: JsonSchema, value: unknown, root: JsonSchema = schema): boolean {
  for (const keyword of Object.keys(schema)) if (!SUPPORTED_KEYWORDS.has(keyword)) throw new Error(`Unsupported keyword ${keyword}`);
  const s = schema as Record<string, unknown>;
  const sub = (child: unknown, item: unknown) => validateJsonSchema(child as JsonSchema, item, root);
  if (typeof s.$ref === 'string') {
    const name = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(s.$ref)?.[1];
    const target = name ? (root.$defs as Record<string, JsonSchema> | undefined)?.[name] : undefined;
    if (!target) throw new Error(`Unresolvable $ref ${s.$ref}`);
    if (!sub(target, value)) return false;
  }
  if (typeof s.type === 'string' && !hasType(value, s.type)) return false;
  if ('const' in s && !equal(value, s.const)) return false;
  if (Array.isArray(s.enum) && !s.enum.some(item => equal(item, value))) return false;
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof s.pattern === 'string' && !pattern(s.pattern).test(value)) return false;
    if (typeof s.minLength === 'number' && length < s.minLength) return false;
    if (typeof s.maxLength === 'number' && length > s.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return false;
    if (typeof s.maximum === 'number' && value > s.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    if (s.uniqueItems === true && value.some((item, i) => value.slice(i + 1).some(other => equal(item, other)))) return false;
    if (s.items !== undefined && !value.every(item => sub(s.items, item))) return false;
  }
  if (isObject(value)) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(s.required) && !s.required.every(key => Object.hasOwn(value, key as string))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) { if (!sub(properties[key], item)) return false; }
      else if (s.additionalProperties === false) return false;
    }
    for (const [key, needs] of Object.entries((s.dependentRequired ?? {}) as Record<string, string[]>)) {
      if (Object.hasOwn(value, key) && !needs.every(other => Object.hasOwn(value, other))) return false;
    }
  }
  if (Array.isArray(s.allOf) && !s.allOf.every(item => sub(item, value))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter(item => sub(item, value)).length !== 1) return false;
  if (s.not !== undefined && sub(s.not, value)) return false;
  if (s.if !== undefined && sub(s.if, value) && s.then !== undefined && !sub(s.then, value)) return false;
  return true;
}

/** Every keyword used anywhere in `schema` (property names under `properties`/`$defs`/`dependentRequired` excluded). */
export function schemaKeywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) { for (const item of schema) schemaKeywords(item, found); return found; }
  if (!isObject(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    found.add(key);
    if (key === 'properties' || key === '$defs') for (const child of Object.values(value as object)) schemaKeywords(child, found);
    else if (!['const', 'enum', 'required', 'dependentRequired'].includes(key)) schemaKeywords(value, found);
  }
  return found;
}
