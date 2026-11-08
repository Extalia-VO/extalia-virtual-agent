import { describe, expect, it } from 'vitest';
import { forgetSeated, seatedAt, setSeatedAt } from '../src/office/scene/movement/deskPresence';

describe('desk presence', () => {
  it('records where a tracked character sits, null while it walks, and forgets removed characters', () => {
    expect(seatedAt('agent-a')).toBeUndefined();
    setSeatedAt('agent-a', 'engineering.desk-1');
    expect(seatedAt('agent-a')).toBe('engineering.desk-1');
    setSeatedAt('agent-a', null);
    expect(seatedAt('agent-a')).toBeNull();
    forgetSeated('agent-a');
    expect(seatedAt('agent-a')).toBeUndefined();
  });
});
