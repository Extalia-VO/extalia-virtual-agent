import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  BRIDGE_CLIENT_SCOPES,
  hasBridgeScope,
  normalizeBridgeClientId,
  normalizeBridgeClientName,
  normalizeBridgeClientScopes,
  requiredBridgeScopeForMethod,
} from '../src/index.js';

describe('bridgeGrants contract (V2-20)', () => {
  it('validates client names, deduplicated canonical scopes, and client IDs', () => {
    expect(normalizeBridgeClientName('  Desktop Companion  ')).toBe('Desktop Companion');
    for (const bad of ['', '   ', 'x'.repeat(81), 'bad\nname', 42, null]) {
      expect(() => normalizeBridgeClientName(bad)).toThrow();
    }

    expect(normalizeBridgeClientScopes(['approvals', 'read', 'read'])).toEqual(['read', 'approvals']);
    expect(normalizeBridgeClientScopes([...BRIDGE_CLIENT_SCOPES])).toEqual([...BRIDGE_CLIENT_SCOPES]);
    for (const bad of [[], 'read', ['unknown'], ['read', 123], undefined]) {
      expect(() => normalizeBridgeClientScopes(bad)).toThrow();
    }

    expect(normalizeBridgeClientId('bc-0123456789ab')).toBe('bc-0123456789ab');
    for (const bad of ['bc-123', 'w-0123456789ab', 'bc-0123456789AB', '../bc-0123456789ab', null]) {
      expect(() => normalizeBridgeClientId(bad)).toThrow('Invalid Bridge client id.');
    }
  });

  it('enforces least-privilege scope classification and fail-closed admin default', () => {
    expect(requiredBridgeScopeForMethod('getState')).toBe('read');
    expect(requiredBridgeScopeForMethod('listApprovals')).toBe('read');
    expect(requiredBridgeScopeForMethod('gatewayDiagnostics')).toBe('read');
    expect(requiredBridgeScopeForMethod('sendPrompt')).toBe('chat');
    expect(requiredBridgeScopeForMethod('createSession')).toBe('chat');
    expect(requiredBridgeScopeForMethod('resolveApproval')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('revokeApproval')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('reconcileWorkerLease')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('saveConnection')).toBe('admin');
    expect(requiredBridgeScopeForMethod('saveWorkspace')).toBe('admin');
    expect(requiredBridgeScopeForMethod('applyIntegration')).toBe('admin');

    // Every registered AgentHostMethod maps cleanly without throwing.
    for (const method of AGENT_HOST_METHODS) {
      expect(BRIDGE_CLIENT_SCOPES).toContain(requiredBridgeScopeForMethod(method));
    }
  });

  it('checks scope grants with admin superseding all narrower scopes', () => {
    expect(hasBridgeScope(['read', 'events'], 'read')).toBe(true);
    expect(hasBridgeScope(['read', 'events'], 'chat')).toBe(false);
    expect(hasBridgeScope(['read', 'events'], 'approvals')).toBe(false);
    expect(hasBridgeScope(['read', 'events'], 'admin')).toBe(false);
    expect(hasBridgeScope(['admin'], 'read')).toBe(true);
    expect(hasBridgeScope(['admin'], 'chat')).toBe(true);
    expect(hasBridgeScope(['admin'], 'approvals')).toBe(true);
    expect(hasBridgeScope(['admin'], 'admin')).toBe(true);
  });
});
