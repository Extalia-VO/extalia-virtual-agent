import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Evidence checker, not a provider runner or a vendor-signed attestation. */
export const ACCEPTANCE_SCOPE = 'four-hop-compaction-long-session';
export const DEFAULT_POLICY = Object.freeze({ minUserTurns: 48, minToolResults: 24, minTranscriptBytes: 256 * 1024, minStageUserTurns: 4 });
export const NATIVE_COMPACTION_CAPABILITIES = Object.freeze({ codex: 'decoder-available', gemini: 'unverified', 'claude-code': 'decoder-available' });
const RUNTIMES = ['codex', 'gemini', 'claude-code', 'codex'];
const SOURCE_IDS = { codex: 'codex', gemini: 'gemini-cli', 'claude-code': 'claude-code' };
const MAX_ARTIFACT = 64 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const epoch = value => typeof value === 'string' ? Date.parse(value) : NaN;
const positive = value => Number.isSafeInteger(value) && value > 0;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textParts = value => typeof value === 'string' ? value : list(value).map(part => string(part?.text)).filter(Boolean).join('\n');
const toolName = name => string(name).replace(/^mcp__[A-Za-z0-9_.-]+__/, '');

/** Never follow artifact symlinks or accept paths outside the immutable evidence directory. */
async function artifactReader(root) {
  root = path.resolve(root);
  check(await realpath(root) === root && (await lstat(root)).isDirectory(), 'Artifact root must be a real directory, not a symlink.');
  let total = 0;
  const cache = new Map();
  return async reference => {
    check(object(reference) && typeof reference.path === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256), 'Invalid artifact reference.');
    const parts = reference.path.split('/');
    check(reference.path.length <= 1024 && !path.isAbsolute(reference.path) && !/[\\\0:]/.test(reference.path)
      && parts.every(part => part && part !== '.' && part !== '..'), 'Artifact path must be a bounded relative path.');
    const key = `${reference.path}:${reference.sha256}`;
    if (cache.has(key)) return cache.get(key);
    check(cache.size < 2048, 'Too many evidence artifacts.');
    let selected = root;
    for (const [index, part] of parts.entries()) {
      selected = path.join(selected, part);
      const info = await lstat(selected);
      check(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() && info.nlink === 1 : info.isDirectory()), 'Evidence artifacts must be regular, unlinked files under real directories.');
    }
    check(await realpath(selected) === selected, 'Artifact directory changed during inspection.');
    const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      check(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_ARTIFACT, 'Evidence artifact exceeds the regular-file limit.');
      const chunks = []; let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_ARTIFACT + 1 - size));
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        size += read.bytesRead; total += read.bytesRead;
        check(size <= MAX_ARTIFACT && total <= MAX_TOTAL, 'Evidence read budget exceeded.');
        chunks.push(buffer.subarray(0, read.bytesRead));
      }
      const finalStat = await handle.stat(), selectedStat = await lstat(selected);
      check(finalStat.size === stat.size && finalStat.mtimeMs === stat.mtimeMs && finalStat.ino === selectedStat.ino
        && finalStat.dev === selectedStat.dev && await realpath(selected) === selected, 'Evidence artifact changed while reading.');
      const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
      check(digest(bytes) === reference.sha256, 'Artifact SHA-256 mismatch.');
      check(Buffer.from(text).equals(bytes), 'Evidence artifact is not valid UTF-8.');
      cache.set(key, text); return text;
    } finally { await handle.close(); }
  };
}

function jsonRows(text) {
  const lines = text.split('\n').filter(line => line.trim());
  check(lines.length <= 200_000, 'Native transcript has too many records.');
  return lines.map(line => { const row = JSON.parse(line); check(object(row), 'Expected native record object.'); return row; });
}
function decodeResult(raw, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof raw === 'string') { try { return decodeResult(JSON.parse(raw), depth + 1); } catch { return undefined; } }
  if (Array.isArray(raw)) return raw.length === 1 ? decodeResult(raw[0], depth + 1) : undefined;
  if (!object(raw) || raw.isError === true || raw.is_error === true || raw.error) return undefined;
  if (typeof raw.canonicalId === 'string') return raw;
  if (raw.functionResponse) return decodeResult(raw.functionResponse.response, depth + 1);
  if (raw.result !== undefined) return decodeResult(raw.result, depth + 1);
  if (raw.output !== undefined) return decodeResult(raw.output, depth + 1);
  if (Array.isArray(raw.content)) return decodeResult(textParts(raw.content), depth + 1);
  if (raw.type === 'text') return decodeResult(raw.text, depth + 1);
  return undefined;
}
function argumentsOf(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return undefined; } }
  return raw;
}

/** Narrow raw-format decoders reuse the formats recognized by packages/importers/src/parsers.ts. */
export function decodeNativeTranscript(runtime, text) {
  const events = [], calls = new Map(); let nativeSessionId;
  const add = event => { events.push({ ...event, key: digest(JSON.stringify(event)) }); };
  const call = (id, name, args, at) => { if (id) calls.set(id, { callId: id, name, args: argumentsOf(args), callAt: at }); };
  const result = (id, raw, at, ok = true) => {
    const selected = calls.get(id);
    if (!selected) return;
    calls.delete(id);
    const serialized = JSON.stringify(raw) ?? '';
    add({ kind: 'tool', ...selected, at, ok, output: decodeResult(raw), outputDigest: digest(serialized), bytes: Buffer.byteLength(serialized) });
  };
  if (runtime === 'codex') {
    const rows = jsonRows(text), identities = new Set(rows.filter(row => row.type === 'session_meta').map(row => row.payload?.id));
    check(identities.size === 1 && typeof [...identities][0] === 'string', 'Codex transcript identity is missing or ambiguous.');
    nativeSessionId = [...identities][0];
    for (const row of rows) {
      const value = row.payload ?? {}, at = row.timestamp;
      if (row.type === 'compacted' || row.type === 'event_msg' && value.type === 'context_compacted') add({ kind: 'compaction', at });
      if (row.type !== 'response_item') continue;
      if (value.type === 'message' && ['user', 'assistant'].includes(value.role) && value.channel !== 'analysis') {
        add({ kind: value.role, text: textParts(value.content), at });
      } else if (['function_call', 'custom_tool_call'].includes(value.type)) call(value.call_id, value.name, value.arguments ?? value.input, at);
      else if (['function_call_output', 'custom_tool_call_output'].includes(value.type)) result(value.call_id, value.output, at, value.isError !== true && value.is_error !== true);
    }
  } else if (runtime === 'claude-code') {
    const rows = jsonRows(text).filter(row => row.isSidechain !== true);
    const conversational = rows.filter(row => ['user', 'assistant'].includes(row.type) && object(row.message));
    const identities = new Set(conversational.map(row => row.sessionId).filter(Boolean));
    check(identities.size === 1, 'Claude transcript identity is missing or ambiguous.'); nativeSessionId = [...identities][0];
    const byId = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, row]));
    const children = new Map();
    for (const row of conversational) if (row.parentUuid) children.set(row.parentUuid, (children.get(row.parentUuid) ?? 0) + 1);
    let branch;
    if ([...children.values()].some(count => count > 1)) {
      check(conversational.every(row => row.uuid), 'Claude branch identity cannot be verified.');
      branch = new Set(); let row = conversational.at(-1);
      while (row?.uuid && !branch.has(row.uuid)) { branch.add(row.uuid); row = byId.get(row.parentUuid); }
    }
    const seen = new Set();
    for (const row of rows) {
      if (row.sessionId && row.sessionId !== nativeSessionId || row.isApiErrorMessage === true || branch && row.uuid && !branch.has(row.uuid)) continue;
      if (row.uuid) { if (seen.has(row.uuid) || byId.get(row.uuid) !== row) continue; seen.add(row.uuid); }
      if (row.type === 'system' && row.subtype === 'compact_boundary') add({ kind: 'compaction', at: row.timestamp });
      if (!['user', 'assistant'].includes(row.type)) continue;
      const content = row.message?.content;
      const text = textParts(content);
      if (text && row.isMeta !== true && row.isCompactSummary !== true && !/^\s*<local-command-/.test(text)) add({ kind: row.type, text, at: row.timestamp, id: row.uuid });
      for (const block of list(content)) {
        if (block.type === 'tool_use') call(block.id, block.name, block.input, row.timestamp);
        else if (block.type === 'tool_result') result(block.tool_use_id, block.content, row.timestamp, block.is_error !== true);
      }
    }
  } else if (runtime === 'gemini') {
    // The legacy format is sufficient for collection today. JSONL rewinds/patches require
    // their own installed-version acceptance; neither form currently proves compaction.
    const record = JSON.parse(text);
    check(object(record) && typeof record.sessionId === 'string' && typeof record.projectHash === 'string' && Array.isArray(record.messages), 'Unsupported Gemini recording; expected ConversationRecord JSON.');
    nativeSessionId = record.sessionId;
    check(record.messages.length <= 100_000, 'Gemini transcript has too many messages.');
    for (const message of record.messages) {
      if (!['user', 'gemini'].includes(message.type)) continue;
      const text = textParts(message.content);
      if (text) add({ kind: message.type === 'user' ? 'user' : 'assistant', text, at: message.timestamp, id: message.id });
      for (const tool of list(message.toolCalls)) {
        const at = tool.timestamp ?? message.timestamp;
        call(tool.id, tool.name, tool.args, at);
        if (tool.result !== undefined && tool.result !== null) result(tool.id, tool.result, at, !['error', 'cancelled', 'failed', 'failure'].includes(string(tool.status).toLowerCase()));
      }
    }
  } else throw new Error('Unsupported runtime.');
  return { nativeSessionId, events };
}

function freshEvents(before, after, invocation) {
  const old = new Map();
  const identities = new Set(before.events.flatMap(event => event.id ? [`${event.kind}:${event.id}`] : event.callId ? [`tool:${event.callId}`] : []));
  for (const event of before.events) old.set(event.key, (old.get(event.key) ?? 0) + 1);
  return after.events.filter(event => {
    const identity = event.id ? `${event.kind}:${event.id}` : event.callId ? `tool:${event.callId}` : undefined;
    if (identity && identities.has(identity)) return false;
    const previous = old.get(event.key) ?? 0;
    if (previous) { old.set(event.key, previous - 1); return false; }
    const at = epoch(event.at);
    return at >= epoch(invocation.startedAt) && at <= epoch(invocation.endedAt);
  });
}

export async function evaluateAcceptance(manifest, artifactRoot) {
  const gates = [];
  const gate = async (id, task) => {
    try { const result = await task(); gates.push({ id, status: result?.blocked ? 'blocked' : 'passed', detail: result?.detail ?? 'Verified from retained evidence.' }); return result; }
    catch (error) { gates.push({ id, status: 'failed', detail: error instanceof Error ? error.message : 'Invalid evidence.' }); return undefined; }
  };
  const finish = () => ({ schemaVersion: 1, scope: ACCEPTANCE_SCOPE, runId: manifest?.runId ?? null,
    status: gates.some(item => item.status === 'failed') ? 'failed' : gates.some(item => item.status === 'blocked') ? 'blocked' : 'live_pass', gates });
  const valid = await gate('manifest', () => {
    check(object(manifest) && manifest.schemaVersion === 1 && ['live', 'fixture'].includes(manifest.mode), 'Unsupported acceptance manifest.');
    check(typeof manifest.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.runId), 'Invalid run identity.');
    check(/^[a-f0-9]{40}$/.test(manifest.sourceRevision) && manifest.sourceDirty === false, 'Pin a clean source revision.');
    check(list(manifest.stages).length === 4 && manifest.stages.every((stage, index) => stage.runtime === RUNTIMES[index]), 'Expected Codex → Gemini → Claude Code → original Codex.');
    const first = manifest.stages[0], last = manifest.stages[3];
    check(manifest.stages.every(stage => stage.nativeSessionId && stage.hostSessionId && stage.canonicalId === first.canonicalId), 'Every stage must retain the same canonical work identity.');
    check(first.canonicalId && first.nativeSessionId === last.nativeSessionId && first.hostSessionId === last.hostSessionId, 'The final Codex stage must resume the original native and host session.');
    check(new Set(manifest.stages.slice(0, 3).map(stage => stage.hostSessionId)).size === 3, 'Three distinct host endpoints are required.');
    check(object(manifest.objective) && typeof manifest.objective.requiredFact === 'string' && manifest.objective.requiredFact.length >= 16 && manifest.objective.requiredFact.length <= 240, 'Provide one bounded original checkpoint fact.');
    return { valid: true };
  });
  if (!valid) return finish();
  let read;
  const root = await gate('artifact-root', async () => { read = await artifactReader(artifactRoot); return { valid: true }; });
  if (!root) return finish();
  await gate('live-evidence', () => ({ blocked: manifest.mode !== 'live', detail: manifest.mode === 'live' ? 'Collector declares live evidence; hashes do not authenticate a vendor or a human collector.' : 'Synthetic fixtures cannot satisfy live acceptance.' }));
  const stages = [], seen = new Set(), previousTranscripts = new Map(); let previousEnd = -Infinity;
  for (const [stageIndex, stage] of manifest.stages.entries()) {
    const parsed = await gate(`stage-${stageIndex}-native-invocations`, async () => {
      check(typeof stage.version === 'string' && stage.version.trim() && stage.version.length <= 200, 'Record the runtime version.');
      check(list(stage.operations).length > 0 && stage.operations.length <= 100, 'Record bounded native operations for each stage.');
      const operations = [], unique = [];
      for (const operation of stage.operations) {
        check(['initial', 'pressure', 'checkpoint', 'compaction', 'recovery'].includes(operation.kind), 'Unknown operation kind.');
        const invocation = JSON.parse(await read(operation.invocation));
        const prompt = await read(operation.prompt), reply = await read(operation.reply), stdout = await read(operation.stdout);
        check(invocation.kind === 'native-cli' && invocation.runId === manifest.runId && invocation.runtime === stage.runtime
          && invocation.version === stage.version && invocation.nativeSessionId === stage.nativeSessionId, 'Invocation provenance does not match this stage.');
        check(typeof invocation.executable === 'string' && path.isAbsolute(invocation.executable) && /^[a-f0-9]{64}$/.test(invocation.executableSha256)
          && Array.isArray(invocation.argv) && invocation.argv.every(value => typeof value === 'string') && invocation.argv.includes(stage.nativeSessionId), 'Pin the executable and exact native resume arguments.');
        check(positive(invocation.pid) && invocation.exitCode === 0 && !invocation.signal && !invocation.problem, 'Native invocation did not settle successfully.');
        check(epoch(invocation.startedAt) >= previousEnd && epoch(invocation.endedAt) >= epoch(invocation.startedAt), 'Native invocation timestamps are missing, overlapping or out of order.');
        check(invocation.inputSha256 === digest(prompt) && invocation.responseSha256 === digest(reply) && invocation.stdoutSha256 === digest(stdout), 'Invocation input, output or response identity differs.');
        const beforeText = await read(operation.beforeTranscript), afterText = await read(operation.transcript);
        if (stage.runtime !== 'gemini') check(afterText.startsWith(beforeText), 'JSONL evidence must preserve the existing native prefix; an unverified rewrite cannot prove freshness.');
        else {
          const beforeRecord = JSON.parse(beforeText), afterRecord = JSON.parse(afterText);
          check(Array.isArray(beforeRecord.messages) && Array.isArray(afterRecord.messages)
            && beforeRecord.messages.every((message, index) => same(message, afterRecord.messages[index])), 'Gemini evidence must preserve existing messages; an unverified rewrite cannot prove freshness.');
        }
        const identity = `${stage.runtime}:${stage.nativeSessionId}`, preceding = previousTranscripts.get(identity);
        check(preceding === undefined || preceding === beforeText, 'The next native before-transcript differs from the previous retained after-transcript.');
        const before = decodeNativeTranscript(stage.runtime, beforeText), after = decodeNativeTranscript(stage.runtime, afterText);
        check(before.nativeSessionId === stage.nativeSessionId && after.nativeSessionId === stage.nativeSessionId, 'Raw native transcript identity differs from the selected stage.');
        const fresh = freshEvents(before, after, invocation);
        const input = fresh.find(event => event.kind === 'user' && event.text.trim() === prompt.trim());
        const output = fresh.findLast(event => event.kind === 'assistant' && event.text.trim() === reply.trim());
        check(input && output && fresh.indexOf(input) < fresh.indexOf(output) && epoch(output.at) >= epoch(input.at), 'Missing a fresh native prompt followed by the recorded assistant reply.');
        check(prompt.trim() && reply.trim(), 'Native input and answer must be nonempty.');
        const entered = fresh.filter(event => epoch(event.at) >= epoch(input.at) && fresh.indexOf(event) >= fresh.indexOf(input)
          && (event.kind !== 'tool' || epoch(event.callAt) >= epoch(input.at) && epoch(event.callAt) <= epoch(event.at)));
        for (const event of entered) {
          const identity = `${stage.runtime}:${stage.nativeSessionId}:${event.key}`;
          if (!seen.has(identity)) { seen.add(identity); unique.push(event); }
        }
        operations.push({ ...operation, invocation, prompt, reply, fresh: entered });
        previousTranscripts.set(identity, afterText);
        previousEnd = epoch(invocation.endedAt);
      }
      return { stage, operations, events: unique };
    });
    stages.push(parsed);
  }
  if (stages.some(stage => !stage)) return finish();
  const objective = await gate('original-objective', async () => {
    const firstPrompt = await read(manifest.objective.firstPrompt), checkpoint = await read(manifest.objective.checkpointPrompt), fact = manifest.objective.requiredFact;
    check(stages[0].operations[0].kind === 'initial' && stages[0].operations[0].prompt === firstPrompt, 'The original task must be delivered once at the beginning.');
    check(!firstPrompt.includes(fact) && checkpoint.includes(fact), 'The recovery fact must enter only in the later checkpoint.');
    const checkpoints = stages.flatMap(stage => stage.operations).filter(operation => operation.kind === 'checkpoint');
    check(checkpoints.length === 1 && stages[0].operations.includes(checkpoints[0]) && checkpoints[0].prompt === checkpoint, 'Exactly one checkpoint prompt is required in the original Codex session.');
    for (const [index, stage] of stages.entries()) for (const [operationIndex, operation] of stage.operations.entries()) {
      if (operation === checkpoints[0] || index > 0 && operationIndex === 0) continue;
      check(!operation.prompt.includes(fact), 'A direct prompt reinjected the checkpoint fact.');
      if (index !== 0 || operationIndex !== 0) check(!operation.prompt.includes(firstPrompt), 'A direct prompt reinjected the original task.');
    }
    return { fact, checkpoint, checkpointInvocation: checkpoints[0].invocation };
  });
  const transfers = await gate('reviewed-transfers', async () => {
    check(list(manifest.transfers).length === 3, 'Retain exactly three reviewed transfer receipts.');
    const receipts = [], codes = [];
    for (const [index, transfer] of manifest.transfers.entries()) {
      check(transfer.fromStage === index && transfer.toStage === index + 1, 'Transfer order differs from the four-stage chain.');
      const reviewed = await read(transfer.reviewedPacket), delivered = await read(transfer.deliveredPacket), receipt = JSON.parse(await read(transfer.receipt));
      check(reviewed === delivered && delivered === stages[index + 1].operations[0].prompt, 'Delivered prompt differs from the exact reviewed handover packet.');
      check(Buffer.byteLength(reviewed) <= 14 * 1024 && receipt.packetDigest === digest(JSON.stringify(reviewed)), 'Packet size or product packet digest differs.');
      check(receipt.canonicalId === stages[index].stage.canonicalId && receipt.sourceSessionId === stages[index].stage.hostSessionId
        && receipt.targetSessionId === stages[index + 1].stage.hostSessionId && receipt.target?.sessionId === receipt.targetSessionId, 'Receipt source, destination or canonical identity differs.');
      check(['manual-ready', 'submitted'].includes(receipt.state) && receipt.retryable === false && !receipt.problem && receipt.operationId && receipt.reviewId, 'Unknown, queued, inspected or failed receipts cannot prove this transfer.');
      check(epoch(receipt.at) >= epoch(stages[index].operations.at(-1).invocation.endedAt)
        && epoch(receipt.at) <= epoch(stages[index + 1].operations[0].invocation.startedAt), 'Receipt is outside the source/destination transition.');
      const matches = [...reviewed.matchAll(/sk-extalia-context-[a-f0-9]{64}/g)].map(match => match[0]);
      check(new Set(matches).size === 1, 'Each packet must contain one distinct scoped archive grant.');
      receipts.push(receipt); codes.push(matches[0]);
      if (index === 2) check(!reviewed.includes(manifest.objective.requiredFact), 'Final handover packet already contains the fact intended for archive recovery.');
    }
    check(new Set(receipts.map(receipt => receipt.operationId)).size === 3 && new Set(codes).size === 3, 'Transfers must use distinct operations and destination grants.');
    return { receipts, codes };
  });
  await gate('long-session', () => {
    const policy = { ...DEFAULT_POLICY, ...manifest.policy };
    check(Object.keys(policy).every(key => key in DEFAULT_POLICY && Number.isSafeInteger(policy[key]) && policy[key] >= DEFAULT_POLICY[key]), 'Acceptance thresholds cannot be weakened.');
    const events = stages.flatMap(stage => stage.events);
    check(events.filter(event => event.kind === 'user').length >= policy.minUserTurns, 'Not enough unique fresh user turns.');
    check(events.filter(event => event.kind === 'tool').length >= policy.minToolResults, 'Not enough unique native tool results.');
    check(stages.every(stage => stage.events.filter(event => event.kind === 'user').length >= policy.minStageUserTurns), 'Every stage must perform sustained native work.');
    check(events.reduce((sum, event) => sum + (event.bytes ?? Buffer.byteLength(event.text ?? '')), 0) >= policy.minTranscriptBytes, 'Fresh observed messages and tool results do not reach the retained-byte threshold.');
  });
  for (const [index, stage] of stages.entries()) await gate(`stage-${index}-native-compaction`, () => {
    if (stage.stage.runtime === 'gemini') return { blocked: true, detail: 'Gemini native compaction observation is unverified. /compress, hooks, transcript replacement and token reductions are not completion evidence.' };
    check(stage.events.some(event => event.kind === 'compaction'), 'No fresh native compaction boundary was recorded.');
    return { detail: 'A native-format boundary exists; the collector must separately review installed-version provenance.' };
  });
  if (objective && transfers) for (let index = 1; index < stages.length; index++) await gate(`stage-${index}-scoped-recovery`, () => {
    const stage = stages[index], boundary = stage.events.findLast(event => event.kind === 'compaction');
    const tools = stage.events.filter(event => event.kind === 'tool' && event.ok && object(event.output)
      && event.args?.access_code === transfers.codes[index - 1]
      && Object.keys(event.args).every(key => ['session_id', 'access_code', 'snapshot_id', 'offset', 'limit'].includes(key))
      && (event.args.offset === undefined || Number.isSafeInteger(event.args.offset) && event.args.offset >= 0)
      && (event.args.limit === undefined || Number.isSafeInteger(event.args.limit) && event.args.limit >= 1 && event.args.limit <= 2)
      && (event.args.session_id === undefined || event.args.session_id === stage.stage.nativeSessionId)
      && (!boundary || epoch(event.callAt) > epoch(boundary.at)));
    const status = tools.filter(event => toolName(event.name) === 'extalia_continuity_status' && event.args.snapshot_id === undefined && event.output.canonicalId === stage.stage.canonicalId);
    const reads = tools.filter(event => toolName(event.name) === 'extalia_continuity_read' && event.output.canonicalId === stage.stage.canonicalId
      && event.args.snapshot_id === event.output.snapshot?.id);
    let matched;
    for (const read of reads) {
      const snapshot = read.output.snapshot;
      const manifestRead = status.find(event => epoch(event.at) < epoch(read.callAt)
        && list(event.output.snapshots).some(summary => same(summary, snapshot)));
      if (!manifestRead || snapshot.sourceId !== 'codex' || snapshot.sessionId !== stages[0].stage.hostSessionId
        || snapshot.nativeSessionId !== stages[0].stage.nativeSessionId || epoch(snapshot.capturedAt) < epoch(objective.checkpointInvocation.endedAt)
        || epoch(snapshot.capturedAt) > epoch(transfers.receipts[0].at)) continue;
      if (index === 3 && !list(read.output.entries).some(entry => entry.kind === 'user' && entry.text === objective.checkpoint)) continue;
      matched = read; break;
    }
    check(matched, 'No successful native status/read pair recovered an original Codex snapshot with the destination grant.');
    const answer = stage.events.findLast(event => event.kind === 'assistant' && epoch(event.at) > epoch(matched.at)
      && (index !== 3 || event.text === stage.operations.at(-1).reply && event.text.includes(objective.fact)));
    check(answer, 'No fresh assistant response follows scoped archive recovery.');
    if (!boundary) return { blocked: true, detail: 'Archive recovery exists, but a verified native compaction boundary is unavailable.' };
  });
  await gate('restart-retention', async () => {
    check(list(manifest.restarts).length > 0 && manifest.restarts.length <= 10, 'Retain a final host restart evidence pair.');
    let complete = false;
    for (const restart of manifest.restarts) {
      const before = JSON.parse(await read(restart.before)), after = JSON.parse(await read(restart.after));
      check(before.runId === manifest.runId && after.runId === manifest.runId && positive(before.pid) && positive(after.pid) && before.pid !== after.pid
        && epoch(after.at) > epoch(before.at), 'Restart evidence requires distinct host process identities and ordered timestamps.');
      check(before.view?.canonicalId === stages[0].stage.canonicalId && after.view?.canonicalId === before.view.canonicalId
        && before.view.persistent === true && after.view.persistent === true, 'Restart lost the durable canonical work identity.');
      check(same(before.view.handovers, after.view.handovers) && same(before.view.snapshots, after.view.snapshots), 'Restart changed retained receipts or snapshot provenance.');
      if (transfers && epoch(before.at) >= epoch(stages[3].operations.at(-1).invocation.endedAt)) {
        check(transfers.receipts.every(receipt => list(after.view.handovers).some(retained => same(retained, receipt))), 'Final restart did not retain all three exact receipts.');
        check(stages.slice(0, 3).every(stage => list(after.view.snapshots).some(snapshot => snapshot.sessionId === stage.stage.hostSessionId
          && snapshot.sourceId === SOURCE_IDS[stage.stage.runtime] && snapshot.nativeSessionId === stage.stage.nativeSessionId)), 'Final restart did not retain all three original native source identities.');
        complete = true;
      }
    }
    check(complete, 'A complete post-chain host restart has not been recorded.');
  });
  await gate('independent-artifact-verification', async () => {
    const command = JSON.parse(await read(manifest.verification?.command)), result = JSON.parse(await read(manifest.verification?.result));
    check(command.kind === 'independent-artifact-check' && command.runId === manifest.runId && result.runId === manifest.runId
      && typeof command.executable === 'string' && command.executable && Array.isArray(command.argv) && command.argv.every(value => typeof value === 'string')
      && typeof command.cwd === 'string', 'Retain an independent verifier command and result.');
    await read(command.artifact); await read(command.verifier);
    check(result.artifactSha256 === command.artifact.sha256 && result.verifierSha256 === command.verifier.sha256, 'Verifier or tested artifact identity differs.');
    check(positive(result.pid) && result.exitCode === 0 && !result.signal && !result.problem && epoch(result.startedAt) >= epoch(stages[3].operations.at(-1).invocation.endedAt)
      && epoch(result.finishedAt) >= epoch(result.startedAt), 'Independent verifier did not complete successfully after the chain.');
    check(list(result.checks).length >= 3 && result.checks.every(check => check.passed === true && typeof check.id === 'string' && check.id)
      && new Set(result.checks.map(check => check.id)).size === result.checks.length, 'Independent artifact checks are missing, duplicated or failing.');
  });
  return finish();
}

export async function readAcceptanceManifest(file) {
  file = path.resolve(file);
  const initial = await lstat(file);
  check(initial.isFile() && initial.nlink === 1 && !initial.isSymbolicLink() && initial.size <= 1024 * 1024, 'Manifest must be a regular, single-link file no larger than 1 MiB.');
  check(await realpath(file) === file, 'Manifest path must not contain a symbolic link.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    check(before.isFile() && before.nlink === 1 && before.dev === initial.dev && before.ino === initial.ino && before.size === initial.size, 'Manifest changed before reading.');
    const chunks = [], buffer = Buffer.alloc(64 * 1024); let size = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead; check(size <= 1024 * 1024, 'Manifest exceeds 1 MiB.');
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
    const after = await handle.stat(), selected = await lstat(file);
    check(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && selected.dev === before.dev
      && selected.ino === before.ino && selected.nlink === 1 && await realpath(file) === file, 'Manifest changed while reading.');
    const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
    check(Buffer.from(text).equals(bytes), 'Manifest is not valid UTF-8.');
    return JSON.parse(text);
  } finally { await handle.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  check(args.length === 2 && args[0] === '--manifest', 'Usage: node tooling/continuity-acceptance/evaluate.mjs --manifest <manifest.json>');
  const file = path.resolve(args[1]), manifest = await readAcceptanceManifest(file);
  const result = await evaluateAcceptance(manifest, path.dirname(file));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'live_pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
