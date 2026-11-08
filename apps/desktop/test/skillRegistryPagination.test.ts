import { describe, expect, it } from 'vitest';
import { parseAgentCall } from '../src/security';

const cursor = `example-skill/skr_${'a'.repeat(64)}`;
const app = 'extalia://app/index.html';

describe('registry metadata pagination IPC', () => {
  it('allows a single bounded cursor request from the app', () => {
    expect(parseAgentCall(app, undefined, 'skillRegistryPage', [{ cursor }])).toEqual({ method: 'skillRegistryPage', args: [{ cursor }] });
  });
  it('rejects malformed input and untrusted senders before calling a host', () => {
    for (const args of [[], [{ cursor }, {}], [{ cursor: '' }], [{ cursor, profile: 'other' }], [{ cursor, limit: 1000 }]]) {
      expect(() => parseAgentCall(app, undefined, 'skillRegistryPage', args)).toThrow(/Invalid skill catalog/);
    }
    expect(() => parseAgentCall('https://example.com', undefined, 'skillRegistryPage', [{ cursor }])).toThrow('Untrusted sender.');
  });
});
