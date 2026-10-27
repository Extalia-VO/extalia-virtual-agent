import type { ExtaliaEvent } from '@extalia/protocol';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

/**
 * A stand-in `hermes`: records the prompt it reads on stdin and, for every attached file the prompt names
 * (lines `- /absolute/path (type, size)`), whether the file exists, its contents and its mode. The real Hermes is never run.
 */
const FAKE_HERMES = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = entry => fs.appendFileSync(path.join(process.env.HERMES_HOME, 'calls.jsonl'), JSON.stringify(entry) + '\\n');
const out = record => process.stdout.write(JSON.stringify(record) + '\\n');
const zero = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const files = input.split('\\n').filter(line => line.startsWith('- /')).map(line => line.slice(2).split(' (')[0]);
  log({ stdin: input, files: files.map(file => ({ path: file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null })) });
  out({ type: 'system', subtype: 'init', model: 'fake/model', session_id: 'fake_session_1' });
  out({ type: 'text', text: 'Read.' });
  out({ type: 'result', session_id: 'fake_session_1', exit_code: 0, text: 'Read.', tokens: zero, duration_ms: 1 });
});
`;

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

async function setup() {
  const root = await tempDir();
  const project = path.join(root, 'project'), bin = path.join(root, 'bin'), hermesHome = path.join(root, 'home', '.hermes');
  for (const directory of [project, bin, path.join(hermesHome, 'profiles', 'default')]) await mkdir(directory, { recursive: true });
  const executable = path.join(bin, 'hermes');
  await writeFile(executable, FAKE_HERMES);
  await chmod(executable, 0o755);
  const dataDirectory = path.join(root, 'data');
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory, importHome: path.join(root, 'home'),
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: path.join(root, 'home'), HERMES_HOME: hermesHome, EXTALIA_HERMES_BIN: executable },
  });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  await runtime.host.saveWorkspace({ name: 'Hermes', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'default', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = (await runtime.host.getState()).workspaces.find(item => item.runtimeId === 'hermes')!;
  return { runtime, host: runtime.host, events, workspace, hermesHome, dataDirectory };
}

async function calls(hermesHome: string) {
  const text = await readFile(path.join(hermesHome, 'calls.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { stdin: string; files: { path: string; exists: boolean; content: string | null; mode: number | null }[] });
}

describe('attachments in Hermes turns', () => {
  it('writes the files to a private folder, names their paths in the prompt, and removes the folder after the turn', async () => {
    const { host, runtime, events, workspace, hermesHome, dataDirectory } = await setup();
    const session = await host.createSession(workspace.id);
    const notes = await host.uploadAttachment(session.id, { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('# Plan\n').toString('base64') });
    const shot = await host.uploadAttachment(session.id, { name: 'shot.png', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64') });
    await host.sendPrompt(session.id, 'Summarize the files', { attachmentIds: [notes.id, shot.id] });
    for (let i = 0; i < 400 && (runtime.isBusy() || !events.some(event => event.body.type === 'turn.completed')); i++) await new Promise(resolve => setTimeout(resolve, 10));

    const [call] = await calls(hermesHome);
    expect(call!.stdin).toContain('Summarize the files');
    expect(call!.files.map(file => file.path.split(path.sep).pop())).toEqual(['1-notes.md', '2-shot.png']);
    expect(call!.files[0]).toMatchObject({ exists: true, content: '# Plan\n', mode: 0o600 });
    expect(call!.files[1]).toMatchObject({ exists: true, mode: 0o600 });
    expect(path.isAbsolute(call!.files[0]!.path)).toBe(true);
    // The temporary folder is gone once the turn has ended, and nothing is left under the data directory.
    for (const file of call!.files) expect(existsSync(file.path)).toBe(false);
    const cache = await readdir(path.join(dataDirectory, 'cache')).catch(() => [] as string[]);
    expect(cache.filter(name => name.startsWith('attachments-'))).toEqual([]);
    // The prompt event names the files, never their contents.
    const submitted = events.find(event => event.body.type === 'prompt.submitted')!;
    expect(submitted.body).toMatchObject({ text: 'Summarize the files', attachments: [{ name: 'notes.md', kind: 'text' }, { name: 'shot.png', kind: 'image' }] });
    expect(JSON.stringify(events)).not.toContain('# Plan');
  });
});
