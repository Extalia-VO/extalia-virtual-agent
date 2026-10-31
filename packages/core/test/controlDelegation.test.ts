import { describe, expect, it } from 'vitest';
import { parseControlDelegationEnvelope } from '@extalia/protocol';
import { compareControlDelegationReplay, inspectControlDelegationExtension } from '../src/controlDelegation.js';
import fixtures from './fixtures/delegation-inspection.json' with { type: 'json' };

interface Case { name: string; valid: boolean; reason?: string; parent?: unknown; child?: unknown; now?: unknown; previous?: unknown; candidate?: unknown }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const result = (test: Case) => test.valid ? { ok: true, authorityVerified: false, dispatchEligible: false } : { ok: false, reason: test.reason };
const field = (test: Case, key: keyof Case, fallback: unknown) => Object.hasOwn(test, key) ? test[key] : fallback;

describe('pure delegation branch and replay inspection', () => {
  it.each(fixtures.extensionCases as Case[])('extension: $name', test => {
    expect(inspectControlDelegationExtension(field(test, 'parent', fixtures.parent), field(test, 'child', fixtures.child), field(test, 'now', fixtures.now))).toEqual(result(test));
  });
  it.each(fixtures.replayCases as Case[])('replay: $name', test => {
    expect(compareControlDelegationReplay(field(test, 'previous', fixtures.parent), field(test, 'candidate', fixtures.parent))).toEqual(result(test));
  });
  it('retains unknown authority even for structurally consistent siblings', () => {
    // No shared reservation exists here. Two valid siblings must still be admitted
    // by an authoritative transaction; this pure inspection cannot spend a pool.
    const a = clone(fixtures.child), b = clone(fixtures.child);
    b.delegationId = '00000088-1111-4111-8111-111111111111';
    b.taskId = '00000089-1111-4111-8111-111111111111';
    b.idempotencyKey = 'sibling-b';
    for (const child of [a, b]) expect(inspectControlDelegationExtension(fixtures.parent, child, fixtures.now)).toEqual({ ok: true, authorityVerified: false, dispatchEligible: false });
  });
  it('cannot be bypassed by fresh execution IDs when ancestry contains a cycle', () => {
    const child = clone(fixtures.child);
    child.taskId = fixtures.parent.parentTaskId;
    child.executionId = '00000099-1111-4111-8111-111111111111';
    expect(parseControlDelegationEnvelope(child).ok).toBe(false);
    expect(inspectControlDelegationExtension(fixtures.parent, child, fixtures.now)).toEqual({ ok: false, reason: 'invalid-child' });
  });
  it('does not let nonenumerable fields evade idempotency comparison', () => {
    const previous = clone(fixtures.parent), candidate = clone(previous);
    Object.defineProperty(candidate, 'authorityRef', { value: 'different-record', enumerable: false });
    expect(parseControlDelegationEnvelope(candidate).ok).toBe(true);
    expect(compareControlDelegationReplay(previous, candidate)).toEqual({ ok: false, reason: 'conflicting-intent' });
  });
  it('makes no mutation, reservation, new identity or time assumption', () => {
    const parent = clone(fixtures.parent), child = clone(fixtures.child);
    const before = JSON.stringify({ parent, child });
    expect(inspectControlDelegationExtension(parent, child, fixtures.now).ok).toBe(true);
    expect(compareControlDelegationReplay(parent, clone(parent)).ok).toBe(true);
    expect(inspectControlDelegationExtension(parent, child, undefined)).toEqual({ ok: false, reason: 'invalid-time' });
    expect(JSON.stringify({ parent, child })).toBe(before);
  });
});
