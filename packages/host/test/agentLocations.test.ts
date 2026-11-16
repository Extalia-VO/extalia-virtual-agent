import { describe, expect, it, vi } from 'vitest';
import { resolveAgentLocations, resolveHermesLocations, type AgentLocationOptions } from '../src/agentLocations.js';

const options = (patch: Partial<AgentLocationOptions> = {}): AgentLocationOptions => ({
  env: {}, homeDirectory: '/home/example', platform: 'linux', existsDirectory: () => false, ...patch,
});

describe('shared read-only connected-agent locations', () => {
  it.each(['linux', 'darwin'] as const)('keeps known per-user defaults on %s without inventing XDG migrations', platform => {
    const selected = resolveAgentLocations(options({ platform, env: { XDG_CONFIG_HOME: '/custom-config', XDG_DATA_HOME: '/custom-data', XDG_CACHE_HOME: '/custom-cache' } }));
    expect(selected).toMatchObject({ codexHome: '/home/example/.codex', claudeHome: '/home/example/.claude',
      geminiHome: '/home/example/.gemini', geminiSandboxHome: '/home/example/.cache/.gemini',
      antigravityHome: '/home/example/.gemini/antigravity', antigravityConfigHome: '/home/example/.gemini/config',
      hermes: { selectedHome: '/home/example/.hermes', rootHome: '/home/example/.hermes' } });
  });

  it('respects explicit independent overrides and the Gemini base-home convention', () => {
    const selected = resolveAgentLocations(options({ env: { CODEX_HOME: ' /agent/codex ', CLAUDE_CONFIG_DIR: '/agent/claude',
      GEMINI_CLI_HOME: '/agent/gemini-base', ANTIGRAVITY_HOME: '/agent/antigravity', ANTIGRAVITY_CONFIG_DIR: '/agent/antigravity-config', HERMES_HOME: '/agent/hermes' } }));
    expect(selected).toEqual({ codexHome: '/agent/codex', claudeHome: '/agent/claude', geminiHome: '/agent/gemini-base/.gemini',
      geminiSandboxHome: '/agent/gemini-base/.cache/.gemini', antigravityHome: '/agent/antigravity', antigravityConfigHome: '/agent/antigravity-config',
      hermes: { selectedHome: '/agent/hermes', rootHome: '/agent/hermes' } });
  });

  it('does not relocate Antigravity when only the distinct Gemini application overrides its home', () => {
    const selected = resolveAgentLocations(options({ env: { GEMINI_CLI_HOME: '/agent/gemini-only' } }));
    expect(selected.geminiHome).toBe('/agent/gemini-only/.gemini');
    expect(selected.antigravityHome).toBe('/home/example/.gemini/antigravity');
    expect(selected.antigravityConfigHome).toBe('/home/example/.gemini/config');
  });

  it('uses Windows local app data by default and never merges a coexisting legacy home', () => {
    const exists = vi.fn(() => true);
    expect(resolveHermesLocations(options({ platform: 'win32', homeDirectory: 'C:\\Users\\Example', env: { LOCALAPPDATA: 'D:\\UserData\\Local' }, existsDirectory: exists })))
      .toEqual({ selectedHome: 'D:\\UserData\\Local\\hermes', rootHome: 'D:\\UserData\\Local\\hermes' });
    expect(exists).toHaveBeenCalledExactlyOnceWith('D:\\UserData\\Local\\hermes');
  });

  it.each([false, true])('selects the existing legacy Windows home only while the official home is absent (legacy exists: %s)', legacy => {
    const selected = resolveHermesLocations(options({ platform: 'win32', homeDirectory: 'C:\\Users\\Example', env: {},
      existsDirectory: root => legacy && root === 'C:\\Users\\Example\\.hermes' }));
    const root = legacy ? 'C:\\Users\\Example\\.hermes' : 'C:\\Users\\Example\\AppData\\Local\\hermes';
    expect(selected).toEqual({ selectedHome: root, rootHome: root });
  });

  it('keeps an explicit missing Hermes home authoritative and retains its named profile identity', () => {
    const exists = vi.fn(() => true);
    expect(resolveHermesLocations(options({ env: { HERMES_HOME: '~/custom-hermes/profiles/team' }, existsDirectory: exists })))
      .toEqual({ selectedHome: '/home/example/custom-hermes/profiles/team', rootHome: '/home/example/custom-hermes', namedProfile: 'team' });
    expect(exists).not.toHaveBeenCalled();
  });

  it('resolves Windows case-insensitive variables and environment references without consulting the process environment', () => {
    expect(resolveHermesLocations(options({ platform: 'win32', homeDirectory: 'C:\\Users\\Example',
      env: { hermes_home: '%LOCALAPPDATA%\\hermes-custom\\profiles\\team', LocalAppData: 'D:\\LocalData' } })))
      .toEqual({ selectedHome: 'D:\\LocalData\\hermes-custom\\profiles\\team', rootHome: 'D:\\LocalData\\hermes-custom', namedProfile: 'team' });
    expect(resolveHermesLocations(options({ env: { HERMES_HOME: '${CUSTOM_ROOT}/hermes', CUSTOM_ROOT: '/selected' } })).selectedHome).toBe('/selected/hermes');
  });

  it('recognizes a Windows PROFILES component without broadening case-sensitive POSIX roots', () => {
    expect(resolveHermesLocations(options({ platform: 'win32', homeDirectory: 'C:\\Users\\Example',
      env: { HERMES_HOME: 'D:\\AgentData\\PROFILES\\team' } })))
      .toEqual({ selectedHome: 'D:\\AgentData\\PROFILES\\team', rootHome: 'D:\\AgentData', namedProfile: 'team' });
    expect(resolveHermesLocations(options({ env: { HERMES_HOME: '/agent/PROFILES/team' } })))
      .toEqual({ selectedHome: '/agent/PROFILES/team', rootHome: '/agent/PROFILES/team' });
  });

  it.each(['relative/hermes', '${UNRESOLVED_AGENT_HOME}/hermes', '/agent/%UNRESOLVED_AGENT_HOME%/hermes'])(
    'reports an invalid explicit Hermes home without consulting other installations: %s', selectedHome => {
      const exists = vi.fn(() => { throw new Error('Invalid explicit homes must not probe a directory.'); });
      const selected = resolveHermesLocations(options({ env: { HERMES_HOME: selectedHome }, existsDirectory: exists }));
      expect(selected).toMatchObject({ selectedHome, rootHome: selectedHome, problem: expect.stringMatching(/absolute|unresolved/) });
      expect(selected.namedProfile).toBeUndefined(); expect(exists).not.toHaveBeenCalled();
      expect(resolveAgentLocations(options({ env: { HERMES_HOME: selectedHome }, existsDirectory: exists })).problems?.hermes).toBe(selected.problem);
    });

  it.each(['relative-local-data', '%UNRESOLVED_AGENT_HOME%/Local'])(
    'reports invalid Windows LOCALAPPDATA without falling back to legacy history: %s', local => {
      const exists = vi.fn(() => { throw new Error('Invalid native roots must not probe a directory.'); });
      const selected = resolveHermesLocations(options({ platform: 'win32', env: { LOCALAPPDATA: local }, existsDirectory: exists }));
      expect(selected.problem).toMatch(/LOCALAPPDATA.*(?:absolute|unresolved)/);
      expect(selected.selectedHome).toContain(local); expect(exists).not.toHaveBeenCalled();
    });

  it('reports invalid app roots independently and leaves other applications usable', () => {
    const selected = resolveAgentLocations(options({ env: { CODEX_HOME: '../codex', GEMINI_CLI_HOME: '/agent/${UNRESOLVED_GEMINI_HOME}',
      CLAUDE_CONFIG_DIR: '/agent/claude-valid', ANTIGRAVITY_CONFIG_DIR: 'relative-config' } }));
    expect(selected.problems).toEqual({ codex: expect.stringMatching(/absolute/), gemini: expect.stringMatching(/unresolved/), antigravity: expect.stringMatching(/absolute/) });
    expect(selected.claudeHome).toBe('/agent/claude-valid');
    expect(selected.hermes).toEqual({ selectedHome: '/home/example/.hermes', rootHome: '/home/example/.hermes' });
    expect(selected.codexHome).toBe('../codex');
  });

  it('retains a platform data-directory suffix without creating directories', () => {
    expect(resolveHermesLocations(options({ env: { HERMES_DATA_DIR_SUFFIX: '-preview' } })).selectedHome).toBe('/home/example/.hermes-preview');
    expect(resolveHermesLocations(options({ platform: 'win32', env: { HERMES_DATA_DIR_SUFFIX: '-preview' } })).selectedHome)
      .toBe('/home/example/AppData/Local/hermes-preview');
  });
});
