import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityNotes, ObservedCliFamily } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
const nativeId = '11111111-1111-4111-8111-111111111111';
const at = '2026-01-01T00:00:00.000Z';
const notes: ContinuityNotes = { goal: 'Keep the original objective', decisions: 'Retain existing verified artifacts', completed: 'Initial analysis', pending: 'Continue the remaining work', verification: 'Inspect retained evidence', risks: 'Do not replay old tools' };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(family: ObservedCliFamily) {
  const root = await temp('extalia-cli-host-'), home = path.join(root, 'home'), project = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(home); await mkdir(project);
  const profile = path.join(home, `.${family}`);
  const folder = family === 'codex' ? path.join(profile, 'sessions') : family === 'claude' ? path.join(profile, 'projects', 'project') : path.join(profile, 'tmp', 'project', 'chats');
  await mkdir(folder, { recursive: true });
  const transcript = path.join(folder, family === 'codex' ? 'rollout-test.jsonl' : family === 'claude' ? `${nativeId}.jsonl` : 'session-test.json');
  const content = family === 'codex' ? line({ type: 'session_meta', payload: { id: nativeId, cwd: project, timestamp: at } })
    + line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Prior progress' }] } })
    : family === 'claude' ? line({ type: 'assistant', sessionId: nativeId, cwd: project, timestamp: at, message: { content: [{ type: 'text', text: 'Prior progress' }], stop_reason: 'end_turn' } })
      : JSON.stringify({ sessionId: nativeId, projectHash: 'project', projectPath: project, startTime: at, messages: [{ id: 'prior', type: 'gemini', timestamp: at, content: 'Prior progress' }] });
  await writeFile(transcript, content);
  const executable = path.join(root, 'cli-fixture'), captured = path.join(root, 'captured.json'), release = path.join(root, 'release'), reader = path.join(root, 'reader.mjs');
  await writeFile(reader, 'export {};\n');
  // Exercise actual pipe/process ownership. The fixture waits for an explicit release after its native receipt.
  // env resolves Node from the isolated PATH below, including installation paths containing spaces.
  await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'), readline=require('node:readline');
const family=${JSON.stringify(family)}, nativeId=${JSON.stringify(nativeId)}, transcript=${JSON.stringify(transcript)};
const captured=${JSON.stringify(captured)}, release=${JSON.stringify(release)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(process.argv.includes('--version')) { console.log(family+' 1.2.3'); process.exit(0); }
const finish=(text,load)=>{
  fs.writeFileSync(captured,JSON.stringify({text,load,args:process.argv.slice(2),home:process.env.HOME}));
  if(family==='gemini') { const source=JSON.parse(fs.readFileSync(transcript,'utf8')); source.messages.push({type:'gemini',content:'Continued progress',timestamp:${JSON.stringify(at)}}); fs.writeFileSync(transcript,JSON.stringify(source)); }
  else fs.appendFileSync(transcript,JSON.stringify(family==='codex'?{type:'response_item',timestamp:${JSON.stringify(at)},payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Continued progress'}]}}:{type:'assistant',sessionId:nativeId,timestamp:${JSON.stringify(at)},message:{content:[{type:'text',text:'Continued progress'}],stop_reason:'end_turn'}})+'\\n');
  if(family==='codex') { send({type:'thread.started',thread_id:nativeId}); send({type:'turn.completed'}); }
  if(family==='claude') { send({type:'system',session_id:nativeId}); send({type:'result',subtype:'success',is_error:false,session_id:nativeId}); }
  const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);process.exit(0);}},10);
};
if(family==='gemini') {
  let load;
  readline.createInterface({input:process.stdin}).on('line',raw=>{ const call=JSON.parse(raw);
    if(call.method==='initialize')send({jsonrpc:'2.0',id:call.id,result:{agentCapabilities:{loadSession:true}}});
    if(call.method==='session/load'){load=call.params;send({jsonrpc:'2.0',id:call.id,result:{sessionId:nativeId}});}
    if(call.method==='session/prompt'){finish(call.params.prompt[0].text,load);send({jsonrpc:'2.0',id:call.id,result:{stopReason:'end_turn'}});}
  });
} else {let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>finish(text));}
`, { mode: 0o700 });
  const open = () => createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: path.dirname(process.execPath), [`EXTALIA_${family.toUpperCase()}_BIN`]: executable }, observationIntervalMs: 60_000,
    cliResumeArchiveReader: reader, hookNodePath: process.execPath });
  let runtime = await open(); active.add(runtime);
  const connected = await runtime.host.saveConnection({ name: 'Test connection', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'example-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } });
  const state = await runtime.host.saveWorkspace({ name: 'Test project', projectLocation: project, connectionId: connected.connections[0]!.id, crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const source = await runtime.host.createSession(state.workspaces[0]!.id);
  const sourceId = family === 'claude' ? 'claude-code' : family === 'gemini' ? 'gemini-cli' : 'codex';
  const scan = await runtime.host.scanImports([sourceId]);
  const observedState = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
  const observed = observedState.sessions.find(session => session.control === 'observed')!;
  const pair = await runtime.host.previewObservedCliResume!(observed.id);
  await runtime.host.pairObservedCliResume!(observed.id, { reviewId: pair.reviewId, exclusiveOwnerConfirmed: true });
  const controls = await runtime.host.observedControlStatus!(observed.id);
  const capabilityId = controls.routes.find(route => route.route === 'official-cli-resume')!.capabilities.find(capability => capability.available)!.capabilityId!;
  const preview = await runtime.host.previewHandover!(source.id, { target: { kind: 'observed', sessionId: observed.id, capabilityId }, notes });
  return { home, data, captured, release, transcript, source, observed, preview,
    get runtime() { return runtime; },
    async restart() { await runtime.close(); active.delete(runtime); runtime = await open(); active.add(runtime); },
  };
}

// Node shebang executables are a POSIX fixture; protocol/lifecycle unit tests run on every platform.
describe.skipIf(process.platform === 'win32')('host-owned official CLI resume integration', () => {
  it.each(['codex', 'gemini', 'claude'] as const)('hands canonical work to the same %s native session and persists the completed receipt', async family => {
    const f = await fixture(family);
    try {
      const receipt = await f.runtime.host.applyHandover!(f.source.id, { reviewId: f.preview.reviewId, operationId: 'host-handover' });
      expect(receipt).toMatchObject({ state: 'queued', canonicalId: f.preview.canonicalId, targetSessionId: f.observed.id });
      await vi.waitFor(async () => expect(JSON.parse(await readFile(f.captured, 'utf8')).text).toBe(f.preview.packet), { timeout: 5000, interval: 20 });
      expect(f.runtime.isBusy()).toBe(true); // Terminal native receipt alone cannot release the live child.
      const invocation = JSON.parse(await readFile(f.captured, 'utf8'));
      expect(invocation.home).toBe(f.home);
      if (family === 'gemini') expect(invocation.load).toMatchObject({ sessionId: nativeId, mcpServers: [{ name: 'extalia_handover' }] });
      else expect(invocation.args).toContain(nativeId);
      expect(invocation.args).not.toContain('--last');
      await writeFile(f.release, 'release');
      await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false), { timeout: 5000, interval: 20 });
      expect(await f.runtime.host.observedCliResumeStatus!(f.observed.id)).toMatchObject({ nativeSessionId: nativeId, lastOutcome: 'completed' });
      expect(await readFile(f.transcript, 'utf8')).toContain('Continued progress');
      await f.restart();
      expect(await f.runtime.host.observedCliResumeStatus!(f.observed.id)).toMatchObject({ nativeSessionId: nativeId, lastOutcome: 'completed' });
      expect((await f.runtime.host.sessionContinuity!(f.observed.id)).canonicalId).toBe(f.preview.canonicalId);
      expect((await f.runtime.host.getState()).sessions.filter(session => session.control === 'observed').map(session => session.id)).toEqual([f.observed.id]);
    } finally { await f.runtime.close(); }
  });

  it('drains its live child on close and preserves uncertainty without replay after restart', async () => {
    const f = await fixture('codex');
    try {
      await f.runtime.host.applyHandover!(f.source.id, { reviewId: f.preview.reviewId, operationId: 'interrupted-handover' });
      await vi.waitFor(async () => expect(await readFile(f.captured, 'utf8')).toContain('Keep the original objective'), { timeout: 5000, interval: 20 });
      expect(f.runtime.isBusy()).toBe(true);
      const captured = await readFile(f.captured, 'utf8');
      await f.restart();
      expect(f.runtime.isBusy()).toBe(false);
      expect(await f.runtime.host.observedCliResumeStatus!(f.observed.id)).toMatchObject({ nativeSessionId: nativeId, state: 'uncertain', lastOutcome: 'unknown' });
      await expect(f.runtime.host.previewObservedCliResume!(f.observed.id)).rejects.toThrow();
      expect(await readFile(f.captured, 'utf8')).toBe(captured);
    } finally { await f.runtime.close(); }
  });
});
