import { mkdir, realpath, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NativeImportService, type NativeObservationRef } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function database(home: string, cwd: string) {
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'state.db'), db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('same-native-id', 'Temporary project work', cwd, 1_770_000_000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, 'same-native-id', 'user', 'Inspect the project', 1_770_000_000, 1);
  } finally { db.close(); }
  return file;
}
async function fixture() {
  const root = await temp(), project = path.join(root, 'project'), home = path.join(root, 'home'), hermes = path.join(root, 'custom-hermes');
  await mkdir(project); await mkdir(home);
  const primary = await database(hermes, project), named = await database(path.join(hermes, 'profiles', 'team'), project);
  const source = await NativeImportService.create({ homeDirectory: home, env: { HERMES_HOME: hermes } });
  const scan = source.scan();
  const reference = (profile: string): NativeObservationRef => source.observation(scan.scanId, scan.sessions.find(item => item.profile === profile)!.id).reference;
  return { root, project, home, hermes, primary, named, source, reference };
}

describe('retained Hermes control source authority', () => {
  it('pins an identical native id to its exact database, named profile and canonical project', async () => {
    const f = await fixture(), primary = f.source.hermesControlSource(f.reference('default')), named = f.source.hermesControlSource(f.reference('team'));
    expect(primary).toMatchObject({ nativeSessionId: 'same-native-id', profile: 'default', profileHome: await realpath(f.hermes), cwd: await realpath(f.project) });
    expect(named).toMatchObject({ nativeSessionId: 'same-native-id', profile: 'team', profileHome: await realpath(path.dirname(f.named)), cwd: await realpath(f.project) });
    expect(primary!.fingerprint).not.toBe(named!.fingerprint);
    expect(f.source.hermesControlSource({ ...f.reference('default'), path: f.named })).toBeUndefined();
    expect(f.source.hermesControlSource({ locationId: 'loc-hermes-dashboard', sourceId: 'hermes', path: '', nativeSessionId: 'same-native-id' })).toBeUndefined();
  });

  it('keeps ordinary messages stable but invalidates directory, database replacement and missing-session authority', async () => {
    const f = await fixture(), ref = f.reference('team'), original = f.source.hermesControlSource(ref)!;
    let db = new DatabaseSync(f.named);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(2, 'same-native-id', 'assistant', 'Completed the first pass', 1_770_000_001, 1); db.close();
    expect(f.source.hermesControlSource(ref)).toEqual(original);
    const changed = path.join(f.root, 'other-project'); await mkdir(changed);
    db = new DatabaseSync(f.named); db.prepare('UPDATE sessions SET cwd = ?').run(changed); db.close();
    expect(f.source.hermesControlSource(ref)!.fingerprint).not.toBe(original.fingerprint);
    await rename(f.named, `${f.named}.old`); await database(path.dirname(f.named), f.project);
    expect(f.source.hermesControlSource(ref)!.fingerprint).not.toBe(original.fingerprint);
    db = new DatabaseSync(f.named); db.prepare('DELETE FROM sessions').run(); db.close();
    expect(f.source.hermesControlSource(ref)).toBeUndefined();
  });

  it('uses an explicitly selected named home without substituting its default or a sibling', async () => {
    const f = await fixture(), selected = path.dirname(f.named);
    const source = await NativeImportService.create({ homeDirectory: f.home, env: { HERMES_HOME: selected } });
    const scan = source.scan();
    expect(scan.sessions).toHaveLength(1);
    const ref = source.observation(scan.scanId, scan.sessions[0]!.id).reference;
    expect(source.hermesControlSource(ref)).toMatchObject({ profile: 'team', profileHome: await realpath(selected) });
    expect(source.hermesControlSource({ ...ref, path: f.primary })).toBeUndefined();
  });

  it('observes a real empty created session without fabricating a readiness message or model turn', async () => {
    const f = await fixture(), db = new DatabaseSync(f.named);
    db.prepare('DELETE FROM messages').run(); db.close();
    const scan = f.source.scan(), candidate = scan.sessions.find(item => item.profile === 'team')!;
    expect(f.source.preview(scan.scanId, [candidate.id]).sessions).toEqual([]);
    const observed = f.source.observation(scan.scanId, candidate.id);
    expect(observed.session.messages).toEqual([]); expect(observed.steps).toEqual([]);
    expect(observed.session.provenance).toMatchObject({ sourceId: 'hermes', sourceSessionId: 'profile:team:same-native-id' });
    expect(f.source.hermesControlSource(observed.reference)).toMatchObject({ nativeSessionId: 'same-native-id', profile: 'team', cwd: await realpath(f.project) });
    expect(f.source.readObservation(observed.reference).session.messages).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses an escaping database and nonexistent project rather than inventing a working directory', async () => {
    const f = await fixture(), ref = f.reference('team');
    const db = new DatabaseSync(f.named); db.prepare('UPDATE sessions SET cwd = ?').run(path.join(f.root, 'missing')); db.close();
    expect(f.source.hermesControlSource(ref)).toBeUndefined();
    await rename(f.named, `${f.named}.old`);
    const outside = await database(path.join(f.root, 'outside'), f.project);
    await symlink(outside, f.named, 'file');
    expect(f.source.hermesControlSource(ref)).toBeUndefined();
  });
});
