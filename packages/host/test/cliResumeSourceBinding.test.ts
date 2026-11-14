import { realpathSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService, type NativeObservationRef } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const id = 'f8a2d0b1-3d5c-4e6f-a789-0123456789ab';
const otherId = 'a8a2d0b1-3d5c-4e6f-a789-0123456789ab';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(family: 'codex' | 'claude' | 'gemini') {
  // Match the source adapter's canonical spelling, including Windows short paths.
  const root = realpathSync(await temp()), home = path.join(root, 'home'), cwd = path.join(root, 'project');
  const profilePath = path.join(home, `.${family}`);
  const sourceId = family === 'claude' ? 'claude-code' : family === 'gemini' ? 'gemini-cli' : 'codex';
  const folder = family === 'codex' ? path.join(profilePath, 'sessions') : family === 'claude' ? path.join(profilePath, 'projects', 'project') : path.join(profilePath, 'tmp', 'project', 'chats');
  const file = path.join(folder, family === 'codex' ? 'rollout-test.jsonl' : family === 'gemini' ? 'session-test.json' : `${id}.jsonl`);
  await mkdir(folder, { recursive: true }); await mkdir(cwd);
  const content = family === 'codex' ? line({ type: 'session_meta', payload: { id, cwd } })
    : family === 'claude' ? line({ type: 'user', sessionId: id, cwd, message: { content: 'Continue the existing work.' } })
      : JSON.stringify({ sessionId: id, projectPath: cwd, messages: [] });
  await writeFile(file, content);
  const env: Record<string, string | undefined> = {};
  const source = await NativeImportService.create({ homeDirectory: home, env });
  const reference = source.hookReference(sourceId, id, file)!;
  expect(reference).toBeDefined();
  return { root, home, cwd, profilePath, file, content, source, reference, sourceId, env };
}

describe('official CLI resume source authority', () => {
  it.each(['codex', 'claude', 'gemini'] as const)('resolves %s identity and canonical directories from its own registered source', async family => {
    const f = await fixture(family);
    const target = f.source.cliResumeSource(f.reference);
    expect(target).toMatchObject({ family, sourceId: f.sourceId, nativeSessionId: id, cwd: realpathSync(f.cwd), profilePath: realpathSync(f.profilePath) });
    expect(target?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(f.source.cliResumeSource({ ...f.reference, nativeSessionId: otherId })).toBeUndefined();
    expect(f.source.cliResumeSource({ ...f.reference, sourceId: 'hermes' })).toBeUndefined();
    expect(f.source.cliResumeSource({ ...f.reference, nativeSessionId: 'latest' })).toBeUndefined();
  });

  it('keeps source identity across appended progress but invalidates its fresh revision and replaced inode', async () => {
    const f = await fixture('codex'), initial = f.source.cliResumeSource(f.reference)!;
    await appendFile(f.file, line({ type: 'turn_context', payload: { model: 'example-model' } }));
    const advanced = f.source.cliResumeSource(f.reference)!;
    expect(advanced.fingerprint).toBe(initial.fingerprint);
    expect(advanced.revision).not.toBe(initial.revision);
    const replacement = `${f.file}.replacement`;
    await writeFile(replacement, f.content);
    await rename(replacement, f.file);
    expect(f.source.cliResumeSource(f.reference)?.fingerprint).not.toBe(initial.fingerprint);
  });

  it('binds only the selected Codex provider environment key, and invalidates a changed provider selection', async () => {
    const f = await fixture('codex'), config = path.join(f.profilePath, 'config.toml');
    await writeFile(config, 'model_provider="first"\n[model_providers.first]\nenv_key="SELECTED_PROVIDER_KEY"\n[model_providers.second]\nenv_key="OTHER_PROVIDER_KEY"\n');
    const first = f.source.cliResumeSource(f.reference)!;
    expect(first.credentialEnvironmentKeys).toEqual(['SELECTED_PROVIDER_KEY']);
    expect(JSON.stringify(first)).not.toContain('OTHER_PROVIDER_KEY');
    await writeFile(config, 'model_provider="second"\n[model_providers.first]\nenv_key="SELECTED_PROVIDER_KEY"\n[model_providers.second]\nenv_key="OTHER_PROVIDER_KEY"\n');
    const second = f.source.cliResumeSource(f.reference)!;
    expect(second.credentialEnvironmentKeys).toEqual(['OTHER_PROVIDER_KEY']);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.revision).not.toBe(first.revision);
  });

  it.each([
    'model_provider = [',
    'model_provider = 3',
    'model_provider="custom"\nmodel_providers=2',
    'model_provider="custom"\n[model_providers]\ncustom=2',
    'model_provider="custom"\n[model_providers.custom]\nenv_key="BAD-KEY"',
    'model_provider="custom"\n[model_providers.custom]\nenv_key=5',
  ])('fails closed for malformed Codex configuration %#', async config => {
    const f = await fixture('codex'); await writeFile(path.join(f.profilePath, 'config.toml'), config);
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('rejects a Codex configuration symlink outside the selected profile', async () => {
    const f = await fixture('codex'), outside = path.join(f.root, 'outside.toml');
    await writeFile(outside, 'model_provider="custom"\n[model_providers.custom]\nenv_key="OUTSIDE_KEY"');
    await symlink(outside, path.join(f.profilePath, 'config.toml'));
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it.each(['claude', 'gemini'] as const)('invalidates %s review revision when native profile settings change without exposing unrelated values', async family => {
    const f = await fixture(family), settings = path.join(f.profilePath, 'settings.json');
    const initial = f.source.cliResumeSource(f.reference)!;
    await writeFile(settings, JSON.stringify({ model: 'original-route', permissions: { mode: 'ask' } }));
    const configured = f.source.cliResumeSource(f.reference)!;
    expect(configured.fingerprint).toBe(initial.fingerprint);
    expect(configured.revision).not.toBe(initial.revision);
    await writeFile(settings, JSON.stringify({ model: 'changed-route', permissions: { mode: 'ask' } }));
    const changed = f.source.cliResumeSource(f.reference)!;
    expect(changed.revision).not.toBe(configured.revision);
    expect(JSON.stringify(changed)).not.toMatch(/original-route|permissions/);
    if (family === 'claude') expect(changed).toMatchObject({ resumeModel: 'changed-route', resumeModelSource: 'profile' });
    else expect(changed.resumeModel).toBeUndefined();
    await rm(settings);
    expect(f.source.cliResumeSource(f.reference)?.revision).not.toBe(changed.revision);
  });

  it.each(['claude', 'gemini'] as const)('rejects %s profile settings outside the selected profile or beyond the bounded read', async family => {
    const f = await fixture(family), settings = path.join(f.profilePath, 'settings.json'), outside = path.join(f.root, 'outside-settings.json');
    if (process.platform !== 'win32') {
      await writeFile(outside, '{}'); await symlink(outside, settings);
      expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
      await rm(settings);
    }
    await writeFile(settings, ' '.repeat(256 * 1024 + 1));
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
    await rm(settings); await mkdir(settings);
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it('reviews exact configured Claude model candidates from profile, current project, local and shell in order', async () => {
    const f = await fixture('claude'), projectSettings = path.join(f.cwd, '.claude');
    await writeFile(path.join(f.profilePath, 'settings.json'), JSON.stringify({ model: 'router/profile-model' }));
    const profile = f.source.cliResumeSource(f.reference)!;
    expect(profile).toMatchObject({ resumeModel: 'router/profile-model', resumeModelSource: 'profile' });
    await mkdir(projectSettings);
    await writeFile(path.join(projectSettings, 'settings.json'), JSON.stringify({ model: 'router/project-model' }));
    const project = f.source.cliResumeSource(f.reference)!;
    expect(project).toMatchObject({ resumeModel: 'router/project-model', resumeModelSource: 'project' });
    expect(project.revision).not.toBe(profile.revision);
    await writeFile(path.join(projectSettings, 'settings.local.json'), JSON.stringify({ model: 'router/local-model' }));
    const local = f.source.cliResumeSource(f.reference)!;
    expect(local).toMatchObject({ resumeModel: 'router/local-model', resumeModelSource: 'project' });
    expect(local.revision).not.toBe(project.revision);
    f.env.ANTHROPIC_MODEL = 'router/environment-model';
    const environment = f.source.cliResumeSource(f.reference)!;
    expect(environment).toMatchObject({ resumeModel: 'router/environment-model', resumeModelSource: 'environment' });
    expect(environment.revision).not.toBe(local.revision);
    expect(environment.fingerprint).toBe(profile.fingerprint);
  });

  it('binds Claude native alias selectors without resolving or returning their mapped routes', async () => {
    const f = await fixture('claude');
    f.env.ANTHROPIC_MODEL = 'sonnet'; f.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'router/first-mapping';
    const first = f.source.cliResumeSource(f.reference)!;
    expect(first.resumeModel).toBe('sonnet');
    f.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'router/changed-mapping';
    const changed = f.source.cliResumeSource(f.reference)!;
    expect(changed.resumeModel).toBe('sonnet');
    expect(changed.revision).not.toBe(first.revision);
    expect(JSON.stringify(changed)).not.toContain('router/changed-mapping');
  });

  it.each([null, 42, [], {}, '', ' bad-model', 'model\nother'].map(model => ({ model })))('refuses unsupported configured Claude model types or values %#', async ({ model }) => {
    const f = await fixture('claude'); await writeFile(path.join(f.profilePath, 'settings.json'), JSON.stringify({ model }));
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it('rejects malformed or escaping current-project Claude settings instead of inferring a model', async () => {
    const f = await fixture('claude'), folder = path.join(f.cwd, '.claude'); await mkdir(folder);
    const settings = path.join(folder, 'settings.local.json');
    await writeFile(settings, '{broken'); expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
    await rm(settings);
    if (process.platform !== 'win32') {
      const outside = path.join(f.root, 'outside-project-settings.json'); await writeFile(outside, JSON.stringify({ model: 'outside-model' }));
      await symlink(outside, settings); expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
      await rm(settings);
    }
    f.env.ANTHROPIC_MODEL = '\n'; expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it('rejects a transcript link escaping its own source, archived Codex and a missing project', async () => {
    const f = await fixture('codex');
    const outside = path.join(f.root, 'outside.jsonl');
    if (process.platform !== 'win32') {
      await writeFile(outside, f.content); await rm(f.file); await symlink(outside, f.file);
      expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
    }
    const archive = path.join(f.profilePath, 'archived_sessions'); await mkdir(archive);
    const archivedFile = path.join(archive, 'rollout-test.jsonl'); await writeFile(archivedFile, f.content);
    const archived = f.source.hookReference('codex', id, archivedFile)!;
    expect(archived).toBeDefined();
    expect(f.source.cliResumeSource(archived)).toBeUndefined();
    await rm(f.file); await writeFile(f.file, f.content); await rm(f.cwd, { recursive: true });
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });

  it('never resolves renderer-forged references or paused observations', async () => {
    const f = await fixture('claude');
    expect(f.source.cliResumeSource({ ...f.reference, locationId: 'invented' } as NativeObservationRef)).toBeUndefined();
    const observer = await Observations.create(path.join(f.root, 'state'), f.source, () => undefined, 60_000);
    try {
      const scan = f.source.scan(['claude-code']);
      await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
      const observedId = observer.summaries()[0]!.id;
      expect(observer.cliResumeSource(observedId)?.nativeSessionId).toBe(id);
      await observer.setWatching(observedId, false);
      expect(observer.cliResumeSource(observedId)).toBeUndefined();
      expect(observer.cliResumeSource('invented')).toBeUndefined();
    } finally { await observer.close(); }
  });
});
