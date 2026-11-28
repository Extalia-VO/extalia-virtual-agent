import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  EXECUTION_SAFETY_HOST_METHODS,
  isAgentHostMethod,
  normalizeApprovalSessionFilter,
  normalizeWorkerLeaseId,
  normalizeWorkerLeaseReconcileAction,
} from '../src/index.js';

describe('execution safety host contract', () => {
  it('registers all EXECUTION_SAFETY_HOST_METHODS in AGENT_HOST_METHODS', () => {
    for (const method of EXECUTION_SAFETY_HOST_METHODS) {
      expect(AGENT_HOST_METHODS).toContain(method);
      expect(isAgentHostMethod(method)).toBe(true);
    }
  });

  it('validates optional approval session filters strictly', () => {
    expect(normalizeApprovalSessionFilter(undefined)).toBeUndefined();
    expect(normalizeApprovalSessionFilter(null)).toBeUndefined();
    expect(normalizeApprovalSessionFilter(' session-123 ')).toBe('session-123');
    for (const invalid of ['', '   ', 'x'.repeat(161), 'bad\nid', 42, {}]) {
      expect(() => normalizeApprovalSessionFilter(invalid)).toThrow('Invalid session filter.');
    }
  });

  it('validates worker lease ids and reconcile actions', () => {
    expect(normalizeWorkerLeaseId('wl-0123456789ab')).toBe('wl-0123456789ab');
    for (const badId of ['wl-0123', 'w-0123456789ab', 'wl-0123456789AB', '../wl-0123456789ab', 123, null]) {
      expect(() => normalizeWorkerLeaseId(badId)).toThrow('Invalid worker lease id.');
    }

    expect(normalizeWorkerLeaseReconcileAction('acknowledge')).toBe('acknowledge');
    for (const badAction of ['replay', 'retry', 'delete', '', undefined, null]) {
      expect(() => normalizeWorkerLeaseReconcileAction(badAction)).toThrow(
        'Unsupported worker lease reconciliation action.',
      );
    }
  });
});
