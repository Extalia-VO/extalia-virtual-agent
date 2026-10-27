import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeClaudeHook } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

// v0.0.49: continued Claude Code conversations. A continuation is a new transcript file that starts with copies of the
// earlier file's rows (same uuids and times), then continues under its own session id. Synthesized in temporary homes only.
const temp = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const CWD = '/projects/example';
const OLD = 'claude-continued-old';
const NEW = 'claude-continued-new';
const PARALLEL = 'claude-parallel-branch';
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
/** Past times: the earlier conversation is over before the continuation is created. */
const past = (offsetMs: number) => new Date(Date.now() - 600_000 + offsetMs).toISOString();

const row = (sessionId: string, type: 'user' | 'assistant', uuid: string, parentUuid: string | null, text: string, timestamp: string, model?: string) =>
  line({ type, sessionId, uuid, parentUuid, timestamp, cwd: CWD, message: { role: type, ...(model ? { model, stop_reason: 'end_turn' } : {}),
    content: type === 'user' ? text : [{ type: 'text', text }] } });

/** The earlier conversation as Claude Code wrote it. */
const earlier = (sessionId: string) =>
  row(sessionId, 'user', 'u1', null, 'Plan the example feature', past(0)) +
  row(sessionId, 'assistant', 'a1', 'u1', 'Here is the plan.', past(1000), 'claude-old-model');

async function home() {
  const root = await temp(), homeDir = path.join(root, 'home'), claude = path.join(root, 'claude-home');
  await mkdir(homeDir, { recursive: true });
  const source = await NativeImportService.create({ homeDirectory: homeDir, env: { CLAUDE_CONFIG_DIR: claude } });
  const location = source.locations().find(item => item.sourceId === 'claude-code')!;
  const project = path.join(claude, 'projects', '-projects-example');
  await mkdir(project, { recursive: true });
  const file = (sessionId: string) => path.join(project, `${sessionId}.jsonl`);
  const observe = () => Observations.create(path.join(root, 'state'), source, () => undefined, 60_000, { homeDirectory: homeDir });
  return { root, source, location, file, observe };
}

/** The continuation: the earlier rows copied, then the new session's own rows. */
const continuation = (sessionId: string) => earlier(sessionId) +
  row(sessionId, 'user', 'u2', 'a1', 'Now build it', new Date(Date.now() - 1000).toISOString()) +
  row(sessionId, 'assistant', 'a2', 'u2', 'Built it.', new Date().toISOString(), 'claude-new-model');

describe('continued Claude Code conversations keep one record', () => {
  it('attaches a manually selected transcript to a hook-only session and keeps its identity after restart', async () => {
    const f = await home();
    const observer = await f.observe();
    let before: ReturnType<Observations['summaries']>[number];
    try {
      await observer.receiveHook(normalizeClaudeHook({ session_id: OLD, hook_event_name: 'UserPromptSubmit', prompt: 'Plan' })!);
      before = observer.summaries()[0]!;
      await writeFile(f.file(OLD), earlier(OLD));
      const scan = f.source.scan(['claude-code']);
      await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
      expect(observer.summaries()).toHaveLength(1);
      expect(observer.summaries()[0]).toMatchObject({ id: before.id, agentName: before.agentName, agentGender: before.agentGender });
      await observer.receiveHook(normalizeClaudeHook({ session_id: OLD, hook_event_name: 'SessionEnd' })!);
    } finally { await observer.close(); }
    const resumed = await f.observe();
    try {
      await resumed.receiveHook(normalizeClaudeHook({ session_id: OLD, hook_event_name: 'SessionStart', source: 'resume' })!);
      expect(resumed.summaries()).toHaveLength(1);
      expect(resumed.summaries()[0]).toMatchObject({ id: before!.id, agentName: before!.agentName, agentGender: before!.agentGender });
      expect(resumed.snapshot(before!.id).messages.length).toBeGreaterThan(0);
    } finally { await resumed.close(); }
  });

  it('moves a watched conversation onto the continuing file, keeping its character', async () => {
    const f = await home();
    await writeFile(f.file(OLD), earlier(OLD));
    await pause();
    const observer = await f.observe();
    try {
      await observer.setAutoWatch(f.location.id, true);
      const [before] = observer.summaries();
      expect(before).toMatchObject({ observation: { nativeSessionId: OLD }, model: 'claude-old-model' });

      await pause();
      await writeFile(f.file(NEW), continuation(NEW));
      await observer.refresh();

      const summaries = observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ id: before!.id, agentName: before!.agentName, agentGender: before!.agentGender,
        observation: { nativeSessionId: NEW }, model: 'claude-new-model' });
      expect(observer.events(before!.id).some(event => event.body.type === 'prompt.submitted' && event.body.text === 'Now build it')).toBe(true);

      // The earlier file is not discovered again while it stays unchanged, and a later poll keeps one record.
      await observer.refresh();
      expect(observer.summaries()).toHaveLength(1);
    } finally { await observer.close(); }
  });

  it('does not create a second record when both files are found at the first poll', async () => {
    const f = await home();
    await writeFile(f.file(OLD), earlier(OLD));
    await pause();
    await writeFile(f.file(NEW), continuation(NEW));
    const observer = await f.observe();
    try {
      await observer.setAutoWatch(f.location.id, true);
      const summaries = observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ observation: { nativeSessionId: NEW } });
    } finally { await observer.close(); }
  });

  it('keeps a parallel branch that is still written after the copy as its own record', async () => {
    const f = await home();
    await writeFile(f.file(OLD), earlier(OLD));
    await pause();
    const observer = await f.observe();
    try {
      await observer.setAutoWatch(f.location.id, true);
      await pause();
      await writeFile(f.file(PARALLEL), continuation(PARALLEL));
      // The earlier conversation goes on after the branch was made.
      await pause();
      await appendFile(f.file(OLD), row(OLD, 'user', 'u3', 'a1', 'Also keep the old one going', new Date().toISOString()));
      await observer.refresh();
      expect(observer.summaries().map(item => item.observation?.nativeSessionId).sort()).toEqual([OLD, PARALLEL].sort());
    } finally { await observer.close(); }
  });

  it('takes over a conversation first reported by hooks when its continuation starts', async () => {
    const f = await home();
    await writeFile(f.file(OLD), earlier(OLD));
    await pause();
    const observer = await f.observe();
    const hook = (sessionId: string, transcript: string, payload: Record<string, unknown>) => observer.receiveHook(normalizeClaudeHook({
      session_id: sessionId, transcript_path: transcript, cwd: CWD, ...payload })!);
    try {
      await hook(OLD, f.file(OLD), { hook_event_name: 'UserPromptSubmit', prompt: 'Plan the example feature' });
      const [before] = observer.summaries();
      await pause();
      await writeFile(f.file(NEW), continuation(NEW));
      await hook(NEW, f.file(NEW), { hook_event_name: 'UserPromptSubmit', prompt: 'Now build it' });
      const summaries = observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ id: before!.id, agentName: before!.agentName, observation: { nativeSessionId: NEW, channel: 'hook' } });
    } finally { await observer.close(); }
  });

  it('never creates two records for one session whether a hook or the transcript reports it first', async () => {
    const f = await home();
    const transcript = f.file(OLD);
    await writeFile(transcript, earlier(OLD));
    const observer = await f.observe();
    try {
      await observer.receiveHook(normalizeClaudeHook({ session_id: OLD, transcript_path: transcript, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt: 'Plan' })!);
      await observer.setAutoWatch(f.location.id, true);
      await observer.refresh();
      expect(observer.summaries()).toHaveLength(1);
    } finally { await observer.close(); }

    const second = await f.observe();
    try {
      await second.receiveHook(normalizeClaudeHook({ session_id: OLD, transcript_path: transcript, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt: 'Plan' })!);
      await second.refresh();
      expect(second.summaries()).toHaveLength(1);
    } finally { await second.close(); }
  });
});

describe('the lead model is the newest report, not the last one written', () => {
  it('keeps a newer hook model when a transcript re-read carries an older one', async () => {
    const f = await home();
    const transcript = f.file(OLD);
    await writeFile(transcript, earlier(OLD));
    const observer = await f.observe();
    const hook = (payload: Record<string, unknown>) => observer.receiveHook(normalizeClaudeHook({ session_id: OLD, transcript_path: transcript, cwd: CWD, ...payload })!);
    try {
      await observer.setAutoWatch(f.location.id, true);
      expect(observer.summaries()[0]).toMatchObject({ model: 'claude-old-model' });

      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Switch models', model: 'claude-hook-model' });
      expect(observer.summaries()[0]).toMatchObject({ model: 'claude-hook-model' });

      // Transcript windows re-read with an older model keep the hook's newer one, on every poll.
      await appendFile(transcript, row(OLD, 'assistant', 'a9', 'a1', 'Late reply', past(2000), 'claude-old-model'));
      for (let poll = 0; poll < 3; poll++) {
        await observer.refresh();
        expect(observer.summaries()[0]).toMatchObject({ model: 'claude-hook-model' });
      }

      // A transcript report newer than the hook's wins.
      await appendFile(transcript, row(OLD, 'assistant', 'a10', 'a9', 'Newest reply', new Date(Date.now() + 60_000).toISOString(), 'claude-transcript-newest'));
      await observer.refresh();
      expect(observer.summaries()[0]).toMatchObject({ model: 'claude-transcript-newest' });
    } finally { await observer.close(); }
  });
});
