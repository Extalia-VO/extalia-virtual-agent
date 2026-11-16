import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, isAgentHostMethod } from '../src/agentHost.js';

describe('reviewed Native session workspace transport', () => {
  it('forwards preview and apply through the shared Bridge/Desktop allowlist', () => {
    for (const method of ['previewSessionMove', 'moveSession', 'setSessionProjectRoot']) {
      expect(isAgentHostMethod(method)).toBe(true);
      expect(AGENT_HOST_METHODS.filter(value => value === method)).toHaveLength(1);
    }
  });
});
