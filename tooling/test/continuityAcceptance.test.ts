import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeNativeTranscript, evaluateAcceptance, readAcceptanceManifest } from '../continuity-acceptance/evaluate.mjs';
import { preflight } from '../continuity-acceptance/preflight.mjs';

type Artifact = { path: string; sha256: string };
type Operation = { kind: string; invocation: Artifact; prompt: Artifact; beforeTranscript: Artifact; transcript: Artifact; reply: Artifact; stdout: Artifact };
type Stage = { runtime: string; version: string; nativeSessionId: string; hostSessionId: string; canonicalId: string; operations: Operation[] };
const temporary: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const base = Date.parse('2026-01-02T00:00:00.000Z');
const at = (milliseconds: number) => new Date(base + milliseconds).toISOString();
const FACT = 'CONTINUITY-DECISION-1234567890abcdef12345678';
const CHECKPOINT = `Retain this original checkpoint: ${FACT}. Recover it from the original source archive.`;
const nativeIds = ['native-codex', 'native-gemini', 'native-claude', 'native-codex'];
const sourceIds = ['codex', 'gemini-cli', 'claude-code'];
const runId = 'synthetic-acceptance-test';
const canonicalId = 'canonical-work';
const sourceSnapshot = { id: 'original-checkpoint', sessionId: 'host-0', sourceId: 'codex', nativeSessionId: nativeIds[0],
  title: 'Original source', capturedAt: at(2050), revision: 'revision-original', entries: 2,
  coverage: { mode: 'full', observedEntries: 2, omittedEntries: 0, limits: [] } };
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-continuity-evidence-')); temporary.push(root);
  let fileIndex = 0;
  async function put(value: unknown, name = `evidence-${fileIndex++}.txt`): Promise<Artifact> {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
    return { path: name, sha256: hash(text) };
  }
  async function edit(ref: Artifact, update: (value: Record<string, unknown>) => void) {
    const value = JSON.parse(await readFile(path.join(root, ref.path), 'utf8')); update(value);
    const changed = await put(value, ref.path); ref.sha256 = changed.sha256;
  }
  const packets = [1, 2, 3].map(number => `Continue the original offline artifact task. Read the pinned original evidence before deciding.\nsk-extalia-context-${String(number).repeat(64)}\n`);
  const stages: Stage[] = [];
  const transcripts = new Map<string, Record<string, unknown>[]>();
  for (const [index, runtime] of ['codex', 'gemini', 'claude-code', 'codex'].entries()) {
    const nativeSessionId = nativeIds[index]!, hostSessionId = `host-${index === 3 ? 0 : index}`;
    const rows = transcripts.get(runtime) ?? (runtime === 'codex'
      ? [{ type: 'session_meta', payload: { id: nativeSessionId } }]
      : []);
    const message = (kind: 'user' | 'assistant', text: string, timestamp: string, id: string) => runtime === 'codex'
      ? { type: 'response_item', timestamp, payload: { type: 'message', role: kind, content: [{ type: kind === 'user' ? 'input_text' : 'output_text', text }] } }
      : runtime === 'claude-code' ? { type: kind, sessionId: nativeSessionId, uuid: id, timestamp, message: { content: text } }
        : { type: kind === 'user' ? 'user' : 'gemini', id, timestamp, content: text };
    if (!transcripts.has(runtime)) rows.push(message('user', 'Existing native conversation.', at(-10_000), `seed-${runtime}`));
    const serialized = () => runtime === 'gemini' ? JSON.stringify({ sessionId: nativeSessionId, projectHash: 'project-test', messages: rows }) : rows.map(row => JSON.stringify(row)).join('\n');
    const operations: Operation[] = [];
    for (let turn = 0; turn < 13; turn++) {
      const start = index * 20_000 + turn * 1000;
      const beforeTranscript = await put(serialized());
      const kind = turn === 0 ? 'initial' : index === 0 && turn === 1 ? 'checkpoint' : turn === 8 ? 'compaction' : index > 0 && turn === 9 ? 'recovery' : 'pressure';
      const prompt = turn === 0 ? index === 0 ? 'Implement the offline artifact and verify it.' : packets[index - 1]!
        : kind === 'checkpoint' ? CHECKPOINT : `Perform the next concrete verification step ${index}:${turn}.`;
      rows.push(message('user', prompt, at(start + 100), `user-${index}-${turn}`));
      if (turn === 8) {
        if (runtime === 'codex') rows.push({ type: 'compacted', timestamp: at(start + 200), payload: { message: 'Native summary' } });
        else if (runtime === 'claude-code') rows.push({ type: 'system', subtype: 'compact_boundary', sessionId: nativeSessionId, timestamp: at(start + 200) });
        else rows.push({ type: 'compaction', timestamp: at(start + 200), content: '/compress completed' });
      }
      const tool = (name: string, args: unknown, output: unknown, offset: number, id: string) => {
        const timestamp = at(start + offset);
        if (runtime === 'codex') {
          rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
          rows.push({ type: 'response_item', timestamp: at(start + offset + 50), payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(output) } });
        } else if (runtime === 'claude-code') {
          rows.push({ type: 'assistant', timestamp, sessionId: nativeSessionId, uuid: `${id}-call`, message: { content: [{ type: 'tool_use', id, name, input: args }] } });
          rows.push({ type: 'user', timestamp: at(start + offset + 50), sessionId: nativeSessionId, uuid: `${id}-result`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(output) }] } });
        } else rows.push({ type: 'gemini', id, timestamp, content: '', toolCalls: [{ id, name, args, status: 'success', timestamp,
          result: [{ functionResponse: { response: { output: JSON.stringify(output) } } }] }] });
      };
      if (kind === 'recovery') {
        const access_code = `sk-extalia-context-${String(index).repeat(64)}`;
        tool('mcp__extalia__extalia_continuity_status', { access_code, session_id: nativeSessionId },
          { content: [{ type: 'text', text: JSON.stringify({ canonicalId, snapshots: [sourceSnapshot] }) }] }, 250, `status-${index}`);
        tool('mcp__extalia__extalia_continuity_read', { access_code, session_id: nativeSessionId, snapshot_id: sourceSnapshot.id },
          { content: [{ type: 'text', text: JSON.stringify({ canonicalId, snapshot: sourceSnapshot, entries: [{ id: 'checkpoint-prompt', kind: 'user', text: CHECKPOINT }] }) }] }, 450, `read-${index}`);
      } else tool('read_file', { path: 'normalizer.py' }, 'x'.repeat(6500), 300, `tool-${index}-${turn}`);
      const reply = index === 3 && turn === 12 ? `Recovered original decision ${FACT}; verified the completed artifact.` : `Completed verification ${index}:${turn}.`;
      rows.push(message('assistant', reply, at(start + 700), `reply-${index}-${turn}`));
      const invocation = { kind: 'native-cli', runId, runtime, version: 'synthetic-test-version', nativeSessionId,
        executable: path.join(root, 'synthetic-runtime'), executableSha256: 'a'.repeat(64), argv: ['resume', nativeSessionId], pid: 100 + index,
        exitCode: 0, signal: null, startedAt: at(start), endedAt: at(start + 900), inputSha256: hash(prompt), responseSha256: hash(reply), stdoutSha256: hash(reply) };
      operations.push({ kind, invocation: await put(invocation), prompt: await put(prompt), beforeTranscript,
        transcript: await put(serialized()), reply: await put(reply), stdout: await put(reply) });
    }
    transcripts.set(runtime, rows);
    stages.push({ runtime, version: 'synthetic-test-version', nativeSessionId, hostSessionId, canonicalId, operations });
  }
  const receipts = packets.map((packet, index) => ({ canonicalId, operationId: `operation-${index}`, reviewId: `review-${index}`,
    sourceSessionId: stages[index]!.hostSessionId, targetSessionId: stages[index + 1]!.hostSessionId,
    target: { kind: 'manual', label: 'Reviewed destination', sessionId: stages[index + 1]!.hostSessionId },
    state: 'manual-ready', at: at(index * 20_000 + 19_000), packetDigest: hash(JSON.stringify(packet)), retryable: false }));
  const transfers = [];
  for (const [index, receipt] of receipts.entries()) transfers.push({ fromStage: index, toStage: index + 1,
    reviewedPacket: await put(packets[index]), deliveredPacket: await put(packets[index]), receipt: await put(receipt) });
  const view = { canonicalId, persistent: true, snapshots: [sourceSnapshot, ...stages.slice(1, 3).map((stage, index) => ({
    ...sourceSnapshot, id: `source-${index + 1}`, sourceId: sourceIds[index + 1], sessionId: stage.hostSessionId, nativeSessionId: stage.nativeSessionId,
  }))], handovers: receipts };
  const artifact = await put('def normalize_inventory(records):\n    return []\n', 'verification/normalizer.py');
  const verifier = await put('raise SystemExit(0)\n', 'verification/oracle.py');
  const manifest = { schemaVersion: 1, mode: 'fixture', runId, sourceRevision: 'a'.repeat(40), sourceDirty: false,
    objective: { firstPrompt: stages[0]!.operations[0]!.prompt, checkpointPrompt: stages[0]!.operations[1]!.prompt, requiredFact: FACT }, stages, transfers,
    restarts: [{ before: await put({ runId, pid: 700, at: at(80_000), view }), after: await put({ runId, pid: 701, at: at(81_000), view }) }],
    verification: { command: await put({ kind: 'independent-artifact-check', runId, executable: 'python3', argv: ['-I', '-B', 'oracle.py'], cwd: 'verification', artifact, verifier }),
      result: await put({ runId, pid: 702, exitCode: 0, signal: null, startedAt: at(82_000), finishedAt: at(83_000),
        artifactSha256: artifact.sha256, verifierSha256: verifier.sha256, checks: ['shape', 'order', 'bounds'].map(id => ({ id, passed: true })) }) },
  };
  async function rewrite(runtime: string, transform: (text: string) => string) {
    for (const stage of stages.filter(stage => stage.runtime === runtime)) for (const operation of stage.operations) {
      for (const ref of [operation.beforeTranscript, operation.transcript]) {
        const changed = await put(transform(await readFile(path.join(root, ref.path), 'utf8')), ref.path); ref.sha256 = changed.sha256;
      }
    }
  }
  return { root, manifest, put, edit, rewrite };
}
const gate = (result: Awaited<ReturnType<typeof evaluateAcceptance>>, id: string) => result.gates.find((item: { id: string }) => item.id === id);

describe('cross-agent continuity evidence acceptance', () => {
  it('verifies the complete synthetic contract without promoting it to a live pass', async () => {
    const f = await fixture(), result = await evaluateAcceptance(f.manifest, f.root);
    expect(result.status).toBe('blocked');
    expect(result.gates.filter((item: { status: string }) => item.status === 'failed')).toEqual([]);
    expect(gate(result, 'live-evidence')?.status).toBe('blocked');
    expect(gate(result, 'stage-1-native-compaction')?.status).toBe('blocked');
    expect(gate(result, 'stage-3-scoped-recovery')?.status).toBe('passed');
    expect(gate(result, 'restart-retention')?.status).toBe('passed');
  });

  it('keeps Gemini compaction blocked even when the collector declares live and writes a success marker', async () => {
    const f = await fixture(); f.manifest.mode = 'live';
    const result = await evaluateAcceptance(f.manifest, f.root);
    expect(result.status).toBe('blocked');
    expect(gate(result, 'stage-1-native-compaction')).toMatchObject({ status: 'blocked', detail: expect.stringContaining('unverified') });
  });

  it('rejects corrupt artifacts before accepting their claimed hashes', async () => {
    const f = await fixture(); await writeFile(path.join(f.root, f.manifest.stages[0]!.operations[0]!.reply.path), 'Altered reply');
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('SHA-256') });
  });

  it.each(['../outside.json', '/outside.json', 'nested/../outside.json', 'folder\\outside.json'])('rejects unsafe artifact path %s', async candidate => {
    const f = await fixture(); f.manifest.stages[0]!.operations[0]!.invocation.path = candidate;
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')?.status).toBe('failed');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink even when its target has the expected hash', async () => {
    const f = await fixture(), ref = f.manifest.stages[0]!.operations[0]!.invocation;
    const original = path.join(f.root, ref.path), linked = path.join(f.root, 'linked-invocation.json');
    await symlink(original, linked); ref.path = 'linked-invocation.json';
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('regular') });
  });

  it('requires the original Codex native and host identities at the fourth stage', async () => {
    const f = await fixture(); f.manifest.stages[3]!.nativeSessionId = 'new-codex-session';
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'manifest')).toMatchObject({ status: 'failed', detail: expect.stringContaining('original') });
  });

  it('rejects raw source identity substitution even with matching outer artifact hashes', async () => {
    const f = await fixture(); await f.rewrite('gemini', text => text.replaceAll('native-gemini', 'wrong-native'));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-1-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('identity') });
  });

  it('does not count stale timestamps as a new prompt and reply', async () => {
    const f = await fixture(); await f.edit(f.manifest.stages[0]!.operations[0]!.invocation, value => { value.startedAt = at(950); value.endedAt = at(999); });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('fresh') });
  });

  it('does not count a rewritten Gemini message with a reused historical id as a fresh user turn', async () => {
    const f = await fixture(); await f.rewrite('gemini', text => {
      const record = JSON.parse(text);
      for (const message of record.messages) if (message.id === 'user-1-0') message.id = 'seed-gemini';
      return JSON.stringify(record);
    });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-1-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('fresh') });
  });

  it('rejects redating an existing Codex row inside a newly captured after-transcript', async () => {
    const f = await fixture(), operation = f.manifest.stages[0]!.operations[0]!;
    operation.transcript = await f.put((await readFile(path.join(f.root, operation.transcript.path), 'utf8')).replace(at(-10_000), at(200)));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('prefix') });
  });

  it('rejects replacing Gemini history with new ids and timestamps to claim fresh work', async () => {
    const f = await fixture(), operation = f.manifest.stages[1]!.operations[0]!;
    const after = JSON.parse(await readFile(path.join(f.root, operation.transcript.path), 'utf8'));
    after.messages[0] = { ...after.messages[0], id: 'replaced-history', timestamp: at(20_050) };
    operation.transcript = await f.put(after);
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-1-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('existing messages') });
  });

  it('requires successive native transcript snapshots to join without an unrecorded rewrite', async () => {
    const f = await fixture(); f.manifest.stages[0]!.operations[2]!.beforeTranscript = f.manifest.stages[0]!.operations[0]!.beforeTranscript;
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-0-native-invocations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('previous retained') });
  });

  it('does not treat a user /compact command as a completed Codex compaction', async () => {
    const f = await fixture(); await f.rewrite('codex', text => text.replaceAll('"type":"compacted"', '"type":"unverified-marker"'));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-3-native-compaction')?.status).toBe('failed');
  });

  it('does not accept native recovery through the wrong destination grant', async () => {
    const f = await fixture(); await f.rewrite('codex', text => text.split('\n').map(line => {
      const row = JSON.parse(line);
      if (row.payload?.type === 'function_call' && row.payload.name.includes('continuity_')) {
        const args = JSON.parse(row.payload.arguments); args.access_code = `sk-extalia-context-${'4'.repeat(64)}`; row.payload.arguments = JSON.stringify(args);
      }
      return JSON.stringify(row);
    }).join('\n'));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-3-scoped-recovery')?.status).toBe('failed');
  });

  it('requires a real native status/read pair rather than a final answer claiming recovery', async () => {
    const f = await fixture(); await f.rewrite('codex', text => text.replaceAll('mcp__extalia__extalia_continuity_read', 'unrelated_read'));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-3-scoped-recovery')?.status).toBe('failed');
  });

  it('rejects later-source copies of the original decision', async () => {
    const f = await fixture(); await f.rewrite('codex', text => text.split('\n').map(line => {
      const row = JSON.parse(line);
      if (row.payload?.type === 'function_call_output') {
        const result = JSON.parse(row.payload.output);
        if (result.content?.[0]?.text) {
          result.content[0].text = result.content[0].text.replaceAll('"sourceId":"codex"', '"sourceId":"gemini-cli"');
          row.payload.output = JSON.stringify(result);
        }
      }
      return JSON.stringify(row);
    }).join('\n'));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'stage-3-scoped-recovery')?.status).toBe('failed');
  });

  it('rejects a packet digest computed from raw bytes instead of product packet identity', async () => {
    const f = await fixture(); await f.edit(f.manifest.transfers[0]!.receipt, receipt => { receipt.packetDigest = f.manifest.transfers[0]!.reviewedPacket.sha256; });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'reviewed-transfers')?.status).toBe('failed');
  });

  it('rejects uncertain delivery instead of treating its receipt as completed', async () => {
    const f = await fixture(); await f.edit(f.manifest.transfers[1]!.receipt, receipt => { receipt.state = 'unknown'; });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'reviewed-transfers')?.status).toBe('failed');
  });

  it('rejects a restart that loses original source provenance', async () => {
    const f = await fixture(); await f.edit(f.manifest.restarts[0]!.after, record => {
      const view = record.view as { snapshots: unknown[] }; view.snapshots = view.snapshots.slice(1);
    });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'restart-retention')?.status).toBe('failed');
  });

  it('rejects verifier self-report without a retained matching tested artifact', async () => {
    const f = await fixture(); await f.edit(f.manifest.verification.result, result => { result.artifactSha256 = 'b'.repeat(64); });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'independent-artifact-verification')?.status).toBe('failed');
  });

  it('rejects a verifier problem even if its exit code happens to be zero', async () => {
    const f = await fixture(); await f.edit(f.manifest.verification.result, result => { result.problem = 'Output cap exceeded.'; });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'independent-artifact-verification')?.status).toBe('failed');
  });

  it('rejects duplicate verifier checks and verification before the final reply', async () => {
    const f = await fixture(); await f.edit(f.manifest.verification.result, result => { result.checks = ['one', 'one', 'one'].map(id => ({ id, passed: true })); });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'independent-artifact-verification')?.status).toBe('failed');
    await f.edit(f.manifest.verification.result, result => { result.checks = ['one', 'two', 'three'].map(id => ({ id, passed: true })); result.startedAt = at(0); });
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'independent-artifact-verification')?.status).toBe('failed');
  });

  it('cannot weaken the long-session thresholds', async () => {
    const f = await fixture(); const manifest = { ...f.manifest, policy: { minUserTurns: 1 } };
    expect(gate(await evaluateAcceptance(manifest, f.root), 'long-session')?.status).toBe('failed');
  });

  it('rejects directly giving the original task to the source agent a second time', async () => {
    const f = await fixture(), operation = f.manifest.stages[0]!.operations[2]!;
    const original = await readFile(path.join(f.root, f.manifest.objective.firstPrompt.path), 'utf8');
    const repeated = await readFile(path.join(f.root, operation.prompt.path), 'utf8');
    operation.prompt = await f.put(original);
    await f.edit(operation.invocation, invocation => { invocation.inputSha256 = hash(original); });
    await f.rewrite('codex', text => text.replaceAll(repeated, original));
    expect(gate(await evaluateAcceptance(f.manifest, f.root), 'original-objective')).toMatchObject({ status: 'failed', detail: expect.stringContaining('original task') });
  });

  it('ignores Claude sidechains and API-error synthetic answers', () => {
    const row = { type: 'assistant', sessionId: 'native-claude', timestamp: at(0), uuid: 'main', message: { content: 'lead' } };
    const parsed = decodeNativeTranscript('claude-code', [row, { ...row, uuid: 'side', isSidechain: true, message: { content: 'worker' } },
      { ...row, uuid: 'error', isApiErrorMessage: true, message: { content: 'failure' } }].map(value => JSON.stringify(value)).join('\n'));
    expect(parsed.events.map((event: { text?: string }) => event.text)).toEqual(['lead']);
  });
});

describe('continuity preflight', () => {
  it('reports absent CLIs without making provider calls or promoting decoder support to installed acceptance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-preflight-test-')); temporary.push(root);
    const missing = path.join(root, 'missing-runtime');
    const result = await preflight({ executables: { codex: missing, gemini: missing, 'claude-code': missing } });
    expect(result.status).toBe('blocked'); expect(result.inferenceCalls).toBe(0);
    expect(result.runtimes.every((runtime: { available: boolean }) => !runtime.available)).toBe(true);
    expect(result.runtimes[0]).toMatchObject({ compaction: { decoder: 'decoder-available', installedVersion: 'unverified' } });
  });

  it.skipIf(process.platform === 'win32')('isolates a version probe from the real home and does not inherit credential environment variables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-preflight-probe-')); temporary.push(root);
    const executable = path.join(root, 'probe'), missing = path.join(root, 'missing');
    await writeFile(executable, '#!/bin/sh\nif [ -n "$EXTALIA_ACCEPTANCE_PRIVATE_TEST" ]; then exit 3; fi\nprintf "synthetic-version:%s\\n" "$HOME"\n', { mode: 0o700 });
    const previous = process.env.EXTALIA_ACCEPTANCE_PRIVATE_TEST;
    process.env.EXTALIA_ACCEPTANCE_PRIVATE_TEST = 'untracked-test-value';
    try {
      const result = await preflight({ executables: { codex: executable, gemini: missing, 'claude-code': missing } });
      expect(result.runtimes[0]).toMatchObject({ available: true, probeSucceeded: true, version: expect.stringContaining('synthetic-version:'), compaction: { installedVersion: 'unverified' } });
      const reportedHome = result.runtimes[0]!.version!.slice('synthetic-version:'.length);
      expect(reportedHome).not.toBe(os.homedir()); expect(path.basename(reportedHome)).toBe('codex');
      await expect(readFile(path.join(reportedHome, 'anything'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.status).toBe('blocked');
    } finally {
      if (previous === undefined) delete process.env.EXTALIA_ACCEPTANCE_PRIVATE_TEST; else process.env.EXTALIA_ACCEPTANCE_PRIVATE_TEST = previous;
    }
  });

  it.skipIf(process.platform === 'win32')('bounds a version wrapper whose descendant keeps the output pipes open', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-preflight-descendant-')); temporary.push(root);
    const executable = path.join(root, 'probe'), missing = path.join(root, 'missing');
    await writeFile(executable, '#!/bin/sh\nsleep 30 &\nprintf "synthetic-version\\n"\nexit 0\n', { mode: 0o700 });
    const started = performance.now();
    const result = await preflight({ executables: { codex: executable, gemini: missing, 'claude-code': missing } });
    expect(result.runtimes[0]).toMatchObject({ available: true, probeSucceeded: false, problem: expect.stringContaining('timed out') });
    expect(performance.now() - started).toBeLessThan(9000);
  }, 12_000);

  it.skipIf(process.platform === 'win32')('rejects version provenance when an executable changes during its probe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-preflight-mutation-')); temporary.push(root);
    const executable = path.join(root, 'probe'), missing = path.join(root, 'missing');
    await writeFile(executable, '#!/bin/sh\nprintf "synthetic-version\\n"\nprintf "# changed\\n" >> "$0"\n', { mode: 0o700 });
    const result = await preflight({ executables: { codex: executable, gemini: missing, 'claude-code': missing } });
    expect(result.runtimes[0]).toMatchObject({ available: true, probeSucceeded: false, problem: expect.stringContaining('changed') });
  });
});

describe('acceptance manifest input', () => {
  it('reads only bounded UTF-8 JSON from an unchanged regular file', async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-manifest-')); temporary.push(root);
    const file = path.join(root, 'manifest.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, runId: 'example' }));
    expect(await readAcceptanceManifest(file)).toEqual({ schemaVersion: 1, runId: 'example' });
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await expect(readAcceptanceManifest(file)).rejects.toThrow('UTF-8');
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(readAcceptanceManifest(file)).rejects.toThrow('1 MiB');
    await expect(readAcceptanceManifest(root)).rejects.toThrow('regular');
  });

  it('rejects hard-linked manifests', async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-manifest-link-')); temporary.push(root);
    const original = path.join(root, 'manifest.json'), duplicate = path.join(root, 'duplicate.json');
    await writeFile(original, '{}'); await link(original, duplicate);
    await expect(readAcceptanceManifest(original)).rejects.toThrow('single-link');
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic-link manifests', async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-manifest-symlink-')); temporary.push(root);
    const original = path.join(root, 'manifest.json'), selected = path.join(root, 'selected.json');
    await writeFile(original, '{}'); await symlink(original, selected);
    await expect(readAcceptanceManifest(selected)).rejects.toThrow('regular');
  });
});
