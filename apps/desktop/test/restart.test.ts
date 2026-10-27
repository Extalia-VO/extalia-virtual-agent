import { describe, expect, it } from 'vitest';
import { IPC, reply } from '../src/ipc';
import { ACTIVE_WORK_REFUSAL, parseRestartRequest, restartBlockReason } from '../src/restart';

describe('restart request validation', () => {
  it('accepts no options or a boolean confirmation flag', () => {
    expect(parseRestartRequest(undefined)).toEqual({ acknowledgeActiveWork: false });
    expect(parseRestartRequest({})).toEqual({ acknowledgeActiveWork: false });
    expect(parseRestartRequest({ acknowledgeActiveWork: true })).toEqual({ acknowledgeActiveWork: true });
    expect(parseRestartRequest({ acknowledgeActiveWork: false })).toEqual({ acknowledgeActiveWork: false });
  });

  it('refuses values that are not a plain options object', () => {
    for (const value of [null, 'now', 1, true, [], [{ acknowledgeActiveWork: true }]]) {
      expect(() => parseRestartRequest(value)).toThrow('Restart options must be an object.');
    }
  });

  it('refuses unknown keys, including prototype keys that arrive as own properties', () => {
    for (const value of [{ force: true }, { acknowledgeActiveWork: true, path: '/bin/sh' }, JSON.parse('{"__proto__":{"acknowledgeActiveWork":true}}')]) {
      expect(() => parseRestartRequest(value)).toThrow('Unknown restart option.');
    }
  });

  it('requires the confirmation flag to be a real boolean', () => {
    for (const acknowledgeActiveWork of ['yes', 1, 0, null, {}]) {
      expect(() => parseRestartRequest({ acknowledgeActiveWork })).toThrow('acknowledgeActiveWork must be true or false.');
    }
  });
});

describe('restart block reason', () => {
  it('lets an idle Desktop relaunch proceed without extra confirmation', () => {
    expect(restartBlockReason({ smokeTest: false, busy: false, acknowledgeActiveWork: false })).toBeUndefined();
  });

  it('blocks a relaunch while agents work unless the user confirmed', () => {
    expect(restartBlockReason({ smokeTest: false, busy: true, acknowledgeActiveWork: false })).toBe(ACTIVE_WORK_REFUSAL);
    expect(restartBlockReason({ smokeTest: false, busy: true, acknowledgeActiveWork: true })).toBeUndefined();
  });

  it('never relaunches during smoke tests, whatever the request says', () => {
    expect(restartBlockReason({ smokeTest: true, busy: false, acknowledgeActiveWork: true })).toBe('Restart is disabled during smoke tests.');
  });
});

describe('restart IPC wiring', () => {
  it('uses its own channel, separate from the update channel', () => {
    expect(IPC.restart).toBe('extalia:restart');
    expect(IPC.restart).not.toBe(IPC.update);
  });

  it('reports a refused restart as a safe error value, not a thrown error', async () => {
    const refused = await reply(() => { throw new Error(restartBlockReason({ smokeTest: false, busy: true, acknowledgeActiveWork: false })); });
    expect(refused).toEqual({ ok: false, error: ACTIVE_WORK_REFUSAL });
  });
});
