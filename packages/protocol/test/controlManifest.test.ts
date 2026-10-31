import { describe, expect, it } from 'vitest';
import {
  CONTROL_CAPABILITY_NAMES, parseControlCapabilityManifest, parseOrchestration,
} from '../src/index.js';
import schema from '../schemas/control-capability-manifest.schema.json' with { type: 'json' };
import fixtures from './fixtures/control/capability-manifest.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = () => clone(fixtures.cases[0]!.value);
type JsonObject = Record<string, unknown>;
const object = (value: unknown) => value as JsonObject;

describe('additive control manifest conformance (claims only)', () => {
  it.each(fixtures.cases)('$name', ({ valid, value }) => {
    expect(parseControlCapabilityManifest(value).ok).toBe(valid);
    expect(validateJsonSchema(schema, value)).toBe(valid);
  });
  it('refuses old orchestration capabilities rather than inferring support', () => {
    const legacy = { schemaVersion: 1, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: false, delegate: false };
    expect(parseOrchestration('engineCapabilities', legacy).ok).toBe(true);
    expect(parseControlCapabilityManifest(legacy).ok).toBe(false);
    expect(parseOrchestration('engineCapabilities', base()).ok).toBe(false);
  });
  it('checks closed required objects and every capability before accepting a claim', () => {
    const value = base();
    const mutations = [undefined, null, '', 'unknown', true, 2, [], {}];
    const check = (target: JsonObject, receive: (changed: JsonObject) => unknown) => {
      for (const key of Object.keys(target)) for (const mutation of mutations) {
        const changed = clone(target);
        if (mutation === undefined) delete changed[key]; else changed[key] = mutation;
        const input = receive(changed);
        expect(validateJsonSchema(schema, input), `${key}: ${JSON.stringify(mutation)}`).toBe(parseControlCapabilityManifest(input).ok);
      }
      const changed = { ...target, unexpected: true };
      expect(parseControlCapabilityManifest(receive(changed)).ok).toBe(false);
      expect(validateJsonSchema(schema, receive(changed))).toBe(false);
    };
    check(object(value), changed => changed);
    check(object(value.subject), subject => ({ ...value, subject }));
    check(object(value.capabilities), capabilities => ({ ...value, capabilities }));
    for (const name of CONTROL_CAPABILITY_NAMES) {
      check(object(value.capabilities[name]), entry => ({ ...value, capabilities: { ...value.capabilities, [name]: entry } }));
    }
    const live = clone(fixtures.cases.find(item => item.name === 'scoped supported claim')!.value);
    const entry = object(live.capabilities.sendPrompt);
    check(entry, changed => ({ ...live, capabilities: { ...live.capabilities, sendPrompt: changed } }));
    check(object(entry.verification), verification => ({ ...live, capabilities: { ...live.capabilities, sendPrompt: { ...entry, verification } } }));
  });
  it('applies UTF-16 text limits and retains unknown evidence truth', () => {
    const value = base();
    object(value.capabilities.sendPrompt).reason = '😀'.repeat(1_000);
    expect(parseControlCapabilityManifest(value).ok).toBe(true);
    object(value.capabilities.sendPrompt).reason = `${String(object(value.capabilities.sendPrompt).reason)}x`;
    expect(parseControlCapabilityManifest(value).ok).toBe(false);
    // A syntactically valid reference can be stale or fictional. This pure parser
    // cannot resolve it, grant permissions or certify the external integration.
    const claim = fixtures.cases.find(item => item.name === 'scoped supported claim')!.value;
    const parsed = parseControlCapabilityManifest(claim);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(claim);
  });
  it('refuses prototype-key discriminants without consulting object prototypes', () => {
    for (const mode of ['constructor', '__proto__', 'toString']) {
      expect(parseControlCapabilityManifest({ ...base(), mode }).ok).toBe(false);
    }
    for (const input of [null, [], false, 1, 'extalia.control.v1']) expect(parseControlCapabilityManifest(input).ok).toBe(false);
  });
});
