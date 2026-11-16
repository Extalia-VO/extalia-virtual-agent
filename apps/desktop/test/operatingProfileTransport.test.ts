import { describe, expect, it } from 'vitest';
import { parseAgentCall } from '../src/security';

describe('desktop operating profile admission', () => {
  it('admits profile methods only from the trusted renderer', () => {
    const methods = ['listOperatingProfiles', 'saveOperatingProfile', 'deleteOperatingProfile',
      'setWorkspaceOperatingProfile', 'getSessionOperatingProfile', 'saveSessionOperatingProfile'];
    for (const method of methods) {
      expect(parseAgentCall('extalia://app/index.html', undefined, method, []).method).toBe(method);
      expect(() => parseAgentCall('https://example.com', undefined, method, [])).toThrow();
    }
  });
});
