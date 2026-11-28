import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  PORTABLE_SNAPSHOT_HOST_METHODS,
  requiredBridgeScopeForMethod,
} from '../src/index.js';

describe('Portable owned-data snapshot platform contract', () => {
  it('registers snapshot RPC methods on AGENT_HOST_METHODS', () => {
    for (const method of PORTABLE_SNAPSHOT_HOST_METHODS) {
      expect(AGENT_HOST_METHODS).toContain(method);
    }
  });

  it('enforces read scope for previews/backups list and fail-closed admin scope for export, restore apply, and rollback', () => {
    expect(requiredBridgeScopeForMethod('previewOwnedDataExport')).toBe('read');
    expect(requiredBridgeScopeForMethod('previewOwnedDataRestore')).toBe('read');
    expect(requiredBridgeScopeForMethod('listOwnedDataBackups')).toBe('read');
    expect(requiredBridgeScopeForMethod('exportOwnedDataSnapshot')).toBe('admin');
    expect(requiredBridgeScopeForMethod('applyOwnedDataRestore')).toBe('admin');
    expect(requiredBridgeScopeForMethod('rollbackOwnedDataRestore')).toBe('admin');
  });
});
