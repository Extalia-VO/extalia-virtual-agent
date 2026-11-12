import { describe, expect, it } from 'vitest';
import {
  createEvent, eventBodyJsonSchema, parseEvent, PROTOCOL_VERSION, SKILL_LOAD_LIMITS,
  type BodyOf, type SkillLoadEntry,
} from '../src/index.js';
import { validateJsonSchema } from './jsonSchemaSubset.js';

const base = {
  v: PROTOCOL_VERSION, id: 'skill-receipt-1', at: '2026-11-11T00:00:00Z', sessionId: 'session-1', agentId: 'primary',
  source: { runtime: 'extalia-native', channel: 'system' as const },
};
const entry = (overrides: Partial<SkillLoadEntry> = {}): SkillLoadEntry => ({
  name: 'memory-recall', source: 'builtin', reason: 'default-memory', status: 'loaded', characters: 120, ...overrides,
});
const receipt = (skills: SkillLoadEntry[] = [entry()]): BodyOf<'skills.loaded'> => ({
  type: 'skills.loaded', skills, characters: 200, budgetCharacters: SKILL_LOAD_LIMITS.characters,
});
const valid = (body: unknown) => parseEvent({ ...base, body }).ok;
const schemaValid = (body: unknown) => validateJsonSchema(eventBodyJsonSchema('skills.loaded'), body);

describe('skill-load preparation receipts', () => {
  it('accepts optional bounded counts of skipped candidates omitted from presentation', () => {
    for (const omitted of [0, 1, 4096]) {
      const body = { ...receipt(), omitted };
      expect(valid(body)).toBe(true);
      expect(schemaValid(body)).toBe(true);
    }
  });

  it('rejects invalid or excessive omitted candidate counts', () => {
    for (const omitted of [-1, 1.5, 4097, Number.MAX_SAFE_INTEGER, Number.NaN, null, '1']) {
      const body = { ...receipt(), omitted };
      expect(valid(body)).toBe(false);
      expect(schemaValid(body)).toBe(false);
    }
  });

  it('accepts attributed, bounded source metadata without instruction bodies', () => {
    const body = receipt([
      entry(), entry({ name: 'orchestrator', reason: 'configured-team', status: 'not-configured', characters: 0 }),
      entry({ name: 'example-review', source: 'registry', reason: 'current-context', intent: 'review', characters: 40, revisionId: `skr_${'a'.repeat(64)}` }),
    ]);
    expect(valid(body)).toBe(true);
    expect(schemaValid(body)).toBe(true);
    expect(createEvent({ ...base, body }).body).toEqual(body);
    expect(valid({ type: 'skills.loaded', skills: [], characters: 0, budgetCharacters: 0 })).toBe(true);
  });

  it('rejects raw instructions, free-form reasons and unknown source or status claims', () => {
    const mutations = [
      { body: 'Do something else.' }, { reason: 'because the private prompt said so' }, { source: 'file' },
      { status: 'applied' }, { intent: 'a quoted prompt' }, { name: 'Bad Name' }, { name: 'x\n' },
      { name: 'x'.repeat(65) }, { name: '' }, { revisionId: `skr_${'a'.repeat(64)}` },
    ];
    for (const mutation of mutations) {
      const body = receipt([{ ...entry(), ...mutation } as SkillLoadEntry]);
      expect(valid(body), JSON.stringify(mutation)).toBe(false);
      expect(schemaValid(body), JSON.stringify(mutation)).toBe(false);
    }
    expect(valid({ ...receipt(), context: 'Hidden source material' })).toBe(false);
    expect(schemaValid({ ...receipt(), context: 'Hidden source material' })).toBe(false);
  });

  it('requires complete per-entry accounting and known registry revision syntax', () => {
    const mutations = [
      { characters: -1 }, { characters: 1.5 }, { characters: 0 },
      { characters: SKILL_LOAD_LIMITS.characters + 1 }, { status: 'budget', characters: 120 },
      { status: 'unavailable', characters: 1 }, { status: 'not-configured', characters: 1 },
      { source: 'registry', revisionId: 'revision-1' }, { source: 'registry', revisionId: `skr_${'a'.repeat(64)}\n` },
    ];
    for (const mutation of mutations) {
      const body = receipt([{ ...entry(), ...mutation } as SkillLoadEntry]);
      expect(valid(body), JSON.stringify(mutation)).toBe(false);
      expect(schemaValid(body), JSON.stringify(mutation)).toBe(false);
    }
    for (const status of ['budget', 'unavailable', 'not-configured'] as const) {
      const body = receipt([entry({ status, characters: 0 })]);
      expect(valid(body)).toBe(true);
      expect(schemaValid(body)).toBe(true);
    }
  });

  it('bounds entry counts, numeric totals and rejects malformed nested values', () => {
    const tooMany = Array.from({ length: SKILL_LOAD_LIMITS.entries + 1 }, (_, index) => entry({ name: `skill-${index}`, characters: 1 }));
    for (const body of [
      receipt(tooMany), { ...receipt(), skills: null }, { ...receipt(), skills: [null] },
      { ...receipt(), characters: Number.NaN }, { ...receipt(), characters: Infinity },
      { ...receipt(), characters: SKILL_LOAD_LIMITS.characters + 1 }, { ...receipt(), budgetCharacters: 24_000.5 },
      { ...receipt(), budgetCharacters: -1 }, { ...receipt(), budgetCharacters: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(valid(body)).toBe(false);
      expect(schemaValid(body)).toBe(false);
    }
    const boundary = receipt(Array.from({ length: SKILL_LOAD_LIMITS.entries }, (_, index) => entry({ name: `skill-${index}`, characters: 1 })));
    expect(valid(boundary)).toBe(true);
    expect(schemaValid(boundary)).toBe(true);
  });

  it('refuses duplicate identities and dishonest cross-field totals in the reference validator', () => {
    const duplicate = receipt([entry(), entry({ reason: 'explicit-request', characters: 40 })]);
    expect(valid(duplicate)).toBe(false);
    // Distinct entries with the same name and arithmetic comparisons are semantic schema gaps.
    expect(schemaValid(duplicate)).toBe(true);
    for (const body of [
      { ...receipt(), characters: 119 },
      { ...receipt(), budgetCharacters: 199 },
      { ...receipt([entry(), entry({ name: 'write-tests', characters: 90 })]), characters: 200 },
    ]) {
      expect(valid(body)).toBe(false);
      expect(schemaValid(body)).toBe(true);
    }
    const comment = eventBodyJsonSchema('skills.loaded').$comment;
    expect(comment).toContain('unique skill names');
    expect(comment).toContain('budgetCharacters');
  });

  it('does not accept a receipt with missing required fields or a zero-length loaded entry', () => {
    for (const key of ['skills', 'characters', 'budgetCharacters']) {
      const body: Record<string, unknown> = { ...receipt() }; delete body[key];
      expect(valid(body)).toBe(false);
      expect(schemaValid(body)).toBe(false);
    }
    for (const key of ['name', 'source', 'reason', 'status', 'characters']) {
      const skill: Record<string, unknown> = { ...entry() }; delete skill[key];
      const body = { ...receipt(), skills: [skill] };
      expect(valid(body)).toBe(false);
      expect(schemaValid(body)).toBe(false);
    }
    expect(() => createEvent({ ...base, body: receipt([entry({ characters: 0 })]) })).toThrow(/loaded entries/);
  });
});
