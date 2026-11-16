import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillStoragePaths } from '../src/skillStorage.js';

afterEach(() => vi.restoreAllMocks());
describe('physical skill library paths', () => {
  it.each(['darwin', 'linux'] as const)('uses the global default root on %s while keeping explicit CLI namespaces separate', platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const data = path.resolve('fixture-data');
    expect(skillStoragePaths(data)).toEqual({ root: path.join(data, 'skills'), objects: path.join(data, 'skills/objects'), imports: path.join(data, 'skills/imports'), market: path.join(data, 'skills/market') });
    expect(skillStoragePaths(data, 'other')).toEqual({ root: path.join(data, 'profiles/other/skills'), objects: path.join(data, 'profiles/other/skills/objects'), imports: path.join(data, 'profiles/other/skill-imports'), market: path.join(data, 'profiles/other/skill-market') });
  });
  it('keeps the authoritative Windows compatibility layout', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const data = path.resolve('fixture-data');
    expect(skillStoragePaths(data).root).toBe(path.join(data, 'profiles/default/skills'));
    expect(skillStoragePaths(data).imports).toBe(path.join(data, 'profiles/default/skill-imports'));
    expect(skillStoragePaths(data).market).toBe(path.join(data, 'profiles/default/skill-market'));
  });
});
