import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopProfilePaths } from '../src/profilePaths';

describe('Desktop profile paths', () => {
  it('keeps Chromium data in the shared root on every supported platform', () => {
    for (const platform of ['darwin', 'linux']) {
      const result = desktopProfilePaths({ platform, homeDirectory: '/home/example', env: {} });
      expect(result).toEqual({ dataDirectory: '/home/example/.extalia-vo', userData: '/home/example/.extalia-vo/desktop-profile', sessionData: '/home/example/.extalia-vo/desktop-profile' });
    }
    const result = desktopProfilePaths({ platform: 'win32', homeDirectory: 'C:\\Users\\example', env: {} });
    expect(result.dataDirectory).toBe('C:\\Users\\example\\.extalia-vo');
    expect(result.userData).toBe('C:\\Users\\example\\.extalia-vo\\desktop-profile');
    expect(result.sessionData).toBe(result.userData);
  });

  it('uses EXTALIA_HOME rather than an OS application-data profile', () => {
    const result = desktopProfilePaths({ platform: 'linux', homeDirectory: '/home/example', env: { EXTALIA_HOME: '/tmp/extalia-isolated', XDG_CONFIG_HOME: '/tmp/other-config' } });
    expect(result.userData).toBe('/tmp/extalia-isolated/desktop-profile');
    expect(result.sessionData).toBe(result.userData);
  });

  it('cannot retain Chromium preferences after its temporary Extalia root is removed', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'extalia-desktop-profile-'));
    try {
      const profile = desktopProfilePaths({ platform: process.platform, homeDirectory: home, env: { EXTALIA_HOME: path.join(home, 'profile') } });
      await mkdir(profile.userData, { recursive: true });
      await writeFile(path.join(profile.userData, 'Preferences'), '{"old":true}');
      await rm(profile.dataDirectory, { recursive: true });
      await mkdir(profile.userData, { recursive: true });
      expect(await readdir(profile.userData)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
