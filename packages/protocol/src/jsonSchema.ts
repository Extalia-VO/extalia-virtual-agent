/**
 * JSON Schema (draft 2020-12) building blocks for the generated contract files in
 * `packages/protocol/schemas/` (ADR 0021). The hand-written validators stay the
 * reference: each validator rule carries the schema fragment it enforces, and
 * semantic checks JSON Schema cannot express remain validator-only.
 */

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export type JsonSchema = { readonly [keyword: string]: unknown };

/** JavaScript `String.prototype.trim` whitespace, spelled out because `\s` differs between regex engines. */
const WHITESPACE = '\\x09-\\x0d\\x20\\xa0  -     　﻿';
/** Matches anywhere a string has a character that `trim()` keeps. */
export const NONBLANK_PATTERN = `[^${WHITESPACE}]`;
export const CONTROL_FREE_PATTERN = '^[^\\x00-\\x1f\\x7f]*$';
export const SINGLE_LINE_PATTERN = '^[^\\n\\r]*$';
const DAY = '(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))';
const LEAP_DAY = '(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)-02-29';
/** `YYYY-MM-DDTHH:mm:ss[.sss]Z` on a real Gregorian date, as `isUtcTimestamp` accepts it. */
export const UTC_TIMESTAMP_PATTERN = `^(?:[0-9]{4}-${DAY}|${LEAP_DAY})T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?Z$`;

export const schemaRef = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
