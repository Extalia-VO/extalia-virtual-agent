import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObservedControlStatus, SessionSummary } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { discoverHandoverHarnesses } from '../src/handoverHarnesses.js';
import { isExecutableFile } from '../src/executableDiscovery.js';
import { useTempDirs } from './helpers.js';
const temp = useTempDirs();
const session = (id: string, sourceId: string) => ({ id, control: 'observed', observation: { sourceId } }) as SessionSummary;
const unavailable = async (sessionId: string): Promise<ObservedControlStatus> => ({ sessionId, state: 'unavailable', routes: [] });
const executableName = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;
async function fixture(platform: string = process.platform) {
  const home = await temp(), bin = path.join(home, 'bin'); await mkdir(bin);
  return { sourceSessionId: 'source', boundary: 'workspace-boundary', homeDirectory: home, env: { PATH: bin }, platform, sessions: [] as SessionSummary[], nativeReady: true, antigravityCreateReady: false, control: vi.fn(unavailable), applicationRoots: [path.join(home, 'Applications')],
    checkExecutable: (file: string) => file.startsWith(home + path.sep) ? isExecutableFile(file) : Promise.resolve(false) };
}
describe('handover harness installation versus capability discovery', () => {
  it('never interprets provider connections or a general Gemini profile as installed Antigravity', async () => {
    const f = await fixture(); await mkdir(path.join(f.homeDirectory, '.gemini'));
    expect((await discoverHandoverHarnesses(f)).harnesses.map(x => x.id)).toEqual(['extalia']);
    expect(f.control).not.toHaveBeenCalled();
  });
  it('uses the supplied home for GUI executable fallbacks while ignoring an unrelated environment home', async () => {
    const f = await fixture(), bin = path.join(f.homeDirectory, '.local', 'bin');
    await mkdir(bin, { recursive: true }); await writeFile(path.join(bin, executableName('codex')), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const inventory = await discoverHandoverHarnesses({ ...f, env: { PATH: '', HOME: path.join(f.homeDirectory, 'unrelated'), USERPROFILE: path.join(f.homeDirectory, 'unrelated') } });
    expect(inventory.harnesses.map(item => item.id)).toEqual(['extalia', 'codex']);
    expect(inventory.harnesses.find(item => item.id === 'codex')).toMatchObject({ evidence: ['executable'], existing: 'setup-required', create: 'unsupported' });
    expect(f.control).not.toHaveBeenCalled();
  });
  it('lists installed Kiro/OpenCode without pretending an adapter can create or send', async () => {
    const f = await fixture();
    for (const file of ['kiro', 'opencode']) await writeFile(path.join(f.env.PATH, executableName(file)), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const inventory = await discoverHandoverHarnesses(f);
    for (const id of ['kiro', 'opencode']) expect(inventory.harnesses.find(x => x.id === id)).toMatchObject({ evidence: ['executable'], existing: 'unsupported', create: 'unsupported', reason: 'adapter-unavailable' });
    expect(f.control).not.toHaveBeenCalled();
  });
  it('recognizes a positive application and observed source while keeping setup distinct from delivery', async () => {
    const f = await fixture('darwin'); await mkdir(path.join(f.applicationRoots[0]!, 'Antigravity.app'), { recursive: true });
    f.sessions = [session('existing-codex', 'codex')];
    const inventory = await discoverHandoverHarnesses(f);
    expect(inventory.harnesses.find(x => x.id === 'codex')).toMatchObject({ evidence: ['observed-session'], existing: 'setup-required', sessionIds: ['existing-codex'] });
    expect(inventory.harnesses.find(x => x.id === 'antigravity')).toMatchObject({ evidence: ['application'], create: 'unavailable' });
  });
  it('requires actual current capabilities for ready delivery and preserves only supplied workspace sessions', async () => {
    const f = await fixture(); f.sessions = [session('same-workspace', 'codex')];
    f.control.mockImplementation(async sessionId => ({ sessionId, state: 'ready', routes: [{ route: 'codex-native', state: 'ready', evidence: 'native-attachment', limit: 'existing-native-owner', relatedControls: [], capabilities: [{ action: 'start', available: true, capabilityId: 'current' }] }] }));
    const a = await discoverHandoverHarnesses(f), b = await discoverHandoverHarnesses({ ...f, boundary: 'changed-workspace' });
    expect(a.harnesses.find(x => x.id === 'codex')).toMatchObject({ existing: 'ready', sessionIds: ['same-workspace'] });
    expect(a.revision).not.toBe(b.revision);
    expect(JSON.stringify(a)).not.toContain(f.homeDirectory);
  });
  it('does not substitute another executable for an explicitly unavailable override', async () => {
    const f = await fixture();
    await writeFile(path.join(f.env.PATH, executableName('hermes')), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const inventory = await discoverHandoverHarnesses({ ...f, env: { ...f.env, EXTALIA_HERMES_BIN: path.join(f.homeDirectory, 'missing-hermes') } });
    expect(inventory.harnesses.map(item => item.id)).toEqual(['extalia']);
  });
  it('advertises an explicit Hermes setup step and selected profile without claiming gateway readiness', async () => {
    const f = await fixture();
    await writeFile(path.join(f.env.PATH, executableName('hermes')), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const inventory = await discoverHandoverHarnesses({ ...f, hermesCreateSetup: true, hermesCreationProfile: 'project-team' });
    expect(inventory.harnesses.find(item => item.id === 'hermes')).toMatchObject({ evidence: ['executable'], existing: 'setup-required', create: 'setup-required', creationProfile: 'project-team' });
    expect(f.control).not.toHaveBeenCalled();
  });
  it.each(['other-session', 'stale-route', 'approval-only'] as const)('does not advertise %s control as a ready handover destination', async kind => {
    const f = await fixture(); f.sessions = [session('observed-hermes', 'hermes')];
    f.control.mockImplementation(async sessionId => ({ sessionId: kind === 'other-session' ? 'foreign-session' : sessionId, state: 'ready',
      routes: [{ route: 'hermes-native', state: kind === 'stale-route' ? 'unavailable' : 'ready', evidence: 'native-attachment', limit: 'existing-native-owner', relatedControls: [{ kind: 'approvals', available: true }],
        capabilities: kind === 'approval-only' ? [] : [{ action: 'start', available: true, capabilityId: 'current' }] }] }));
    expect((await discoverHandoverHarnesses(f)).harnesses.find(item => item.id === 'hermes')).toMatchObject({ existing: 'setup-required', create: 'unsupported' });
  });
});
