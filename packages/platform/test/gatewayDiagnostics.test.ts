import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  GATEWAY_HOST_METHODS,
  isAgentHostMethod,
} from '../src/index.js';

describe('gateway diagnostics host contract', () => {
  it('registers gatewayDiagnostics in GATEWAY_HOST_METHODS and AGENT_HOST_METHODS', () => {
    expect(GATEWAY_HOST_METHODS).toContain('gatewayDiagnostics');
    expect(AGENT_HOST_METHODS).toContain('gatewayDiagnostics');
    expect(isAgentHostMethod('gatewayDiagnostics')).toBe(true);
  });
});
