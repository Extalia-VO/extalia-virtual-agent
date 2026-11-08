import { appendFile, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), id = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const home = await temp('extalia-codex-binding-'), codexHome = path.join(home, '.codex'), sessions = path.join(codexHome, 'sessions');
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  const header = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/projects/example' } })}\n`;
  await writeFile(file, header);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const location = source.locations().find(item => item.sourceId === 'codex' && item.path === sessions)!;
  return { home, codexHome, sessions, file, header, source, ref: { locationId: location.id, sourceId: 'codex', nativeSessionId: id, path: file } };
}
it('binds the exact registered UUID/profile and remains stable for append-only native activity', async () => {
  const f = await fixture(), first = f.source.codexQueueSource(f.ref);
  expect(first?.codexHome).toBe(await realpath(f.codexHome));
  await appendFile(f.file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  expect(f.source.codexQueueSource(f.ref)).toEqual(first);
  expect(f.source.codexQueueSource({ ...f.ref, nativeSessionId: '22222222-2222-4222-8222-222222222222' })).toBeUndefined();
  expect(f.source.codexQueueSource({ ...f.ref, locationId: 'unregistered' })).toBeUndefined();
});
it('changes the binding when the source file is replaced and refuses a symlink escape', async () => {
  const f = await fixture(), first = f.source.codexQueueSource(f.ref);
  const replacement = path.join(f.sessions, 'replacement.jsonl'); await writeFile(replacement, f.header); await rename(replacement, f.file);
  expect(f.source.codexQueueSource(f.ref)?.sourceFingerprint).not.toBe(first?.sourceFingerprint);
  if (process.platform !== 'win32') {
    const outside = path.join(f.home, 'outside.jsonl'), link = path.join(f.sessions, 'escape.jsonl');
    await writeFile(outside, f.header); await symlink(outside, link);
    expect(f.source.codexQueueSource({ ...f.ref, path: link })).toBeUndefined();
  }
});
