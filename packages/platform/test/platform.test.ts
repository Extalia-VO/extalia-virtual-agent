import { describe, expect, it } from 'vitest';
import { describeCapabilities, resolveDataDirectory, type Platform } from '../src/index.js';

describe('resolveDataDirectory', () => {
  it('uses the platform application data location', () => {
    expect(resolveDataDirectory({ platform: 'darwin', env: {}, homeDirectory: '/home/someone' })).toBe('/home/someone/Library/Application Support/Extalia');
    expect(resolveDataDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, homeDirectory: 'C:\\Users\\someone' })).toBe('C:\\Users\\someone\\AppData\\Roaming\\Extalia');
    expect(resolveDataDirectory({ platform: 'linux', env: {}, homeDirectory: '/home/someone/' })).toBe('/home/someone/.local/share/extalia');
    expect(resolveDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homeDirectory: '/home/someone' })).toBe('/data/extalia');
  });

  it('ignores relative XDG paths and honors the explicit override', () => {
    expect(resolveDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, homeDirectory: '/home/someone' })).toBe('/home/someone/.local/share/extalia');
    expect(resolveDataDirectory({ platform: 'darwin', env: { EXTALIA_HOME: '/tmp/extalia-test' }, homeDirectory: '/home/someone' })).toBe('/tmp/extalia-test');
  });
});

describe('describeCapabilities', () => {
  it('marks native capabilities as bridge-reachable on the web and unavailable elsewhere', () => {
    const web: Platform = { info: { kind: 'web', appVersion: '0.0.0' }, capabilities: { filesystem: { selectDirectory: async () => null } } };
    const desktop: Platform = { info: { kind: 'desktop', appVersion: '0.0.0' }, capabilities: {} };
    const webStatus = Object.fromEntries(describeCapabilities(web).map(entry => [entry.id, entry.status]));
    expect(webStatus).toMatchObject({ filesystem: 'available', terminal: 'requires-bridge', git: 'requires-bridge', updater: 'unavailable' });
    expect(describeCapabilities(desktop).every(entry => entry.status === 'unavailable')).toBe(true);
  });
});
