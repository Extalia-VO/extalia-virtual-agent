import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { startHookListener, type HookListener } from '../src/hooks/http.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const listeners: HookListener[] = [];
afterEach(async () => { await Promise.all(listeners.splice(0).map(listener => listener.close())); });
it('routes Desktop permissions separately and rejects a foreign Host before invoking it', async () => {
  let approvals = 0, notifications = 0;
  const listener = await startHookListener({
    async handle(_request, response) { notifications++; response.writeHead(204); response.end(); },
    async permissionHandler(_request, response) { approvals++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"decision":"pass","confirmed":false}'); },
  }); listeners.push(listener);
  const send = (host: string, endpoint: string) => new Promise<number>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: listener.port, path: endpoint, method: 'POST', headers: { Host: host } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    outgoing.on('error', reject); outgoing.end();
  });
  expect(await send('example.com', '/api/permissions/codex')).toBe(403);
  expect(approvals).toBe(0);
  expect(await send(`127.0.0.1:${listener.port}`, '/api/permissions/codex')).toBe(200);
  expect(approvals).toBe(1); expect(notifications).toBe(0);
  expect(await send(`127.0.0.1:${listener.port}`, '/api/hooks/codex')).toBe(204);
  expect(notifications).toBe(1);
});
it('resolves only the watched registered native UUID and exact canonical transcript', async () => {
  const root = await temp('extalia-permission-source-'), home = path.join(root, 'home'), sessions = path.join(home, '.codex', 'sessions');
  await mkdir(sessions, { recursive: true });
  const nativeId = '11111111-1111-4111-8111-111111111111', file = path.join(sessions, 'rollout.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: root, timestamp: '2026-01-01T00:00:00Z' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic source' }] } })}\n`);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observations = await Observations.create(path.join(root, 'state'), source, () => undefined, 60_000);
  try {
    const scan = source.scan(['codex']); await observations.observe(scan.scanId, [scan.sessions[0]!.id]);
    const id = observations.summaries()[0]!.id;
    expect(observations.codexPermissionTarget({ session_id: nativeId, transcript_path: file })).toBe(id);
    expect(observations.codexPermissionTarget({ session_id: nativeId, transcript_path: path.join(root, 'outside.jsonl') })).toBeUndefined();
    expect(observations.codexPermissionTarget({ session_id: '22222222-2222-4222-8222-222222222222', transcript_path: file })).toBeUndefined();
    await observations.setWatching(id, false);
    expect(observations.codexPermissionTarget({ session_id: nativeId, transcript_path: file })).toBeUndefined();
  } finally { await observations.close(); }
});
