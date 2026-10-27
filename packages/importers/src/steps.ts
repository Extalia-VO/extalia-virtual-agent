import { safeLabel, safeText, type StopReason } from '@extalia/core';

/**
 * Structured activity read from a native transcript, in source order. Parsers
 * report only what the transcript states; the host turns steps into Extalia
 * Protocol events. `pos` is derived from the step's place in the source (line,
 * message id or row id), so re-reading an unchanged transcript yields the same
 * positions and consumers can deduplicate replays.
 */
interface StepBase {
  pos: string;
  /** ISO timestamp from the source, when it has one. */
  at?: string;
  /** Sub-agent identity when the transcript attributes the step to one. */
  agentId?: string;
}

/**
 * A file attached to a prompt, as the transcript states it. `data` (base64) is kept only for images the
 * source embeds, up to `MAX_INLINE_IMAGE_BYTES`, so the host can keep a private copy to show; everything
 * else is its name, kind and size only.
 */
export interface StepAttachment {
  name: string;
  kind: 'image' | 'text' | 'file';
  size: number;
  mimeType?: string;
  data?: string;
}

/** Embedded images larger than this are listed by name only. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** At most this many attachments are read from one prompt. */
export const MAX_STEP_ATTACHMENTS = 10;

export type TranscriptStep = StepBase & (
  | { type: 'prompt'; text: string; attachments?: StepAttachment[] }
  /** `final` is set only when the source marks the reply as the end of the turn. */
  | { type: 'reply'; text: string; final?: boolean; model?: string }
  | { type: 'tool.call'; tool: string; callId?: string; target?: string; command?: string }
  | { type: 'tool.result'; callId?: string; tool?: string; ok: boolean; output?: string }
  | { type: 'turn.end'; reason?: 'completed' | 'interrupted' }
  /**
   * v0.0.38: a state the source states without a tool call or message: the model
   * reasons (`thinking`), the context is summarized mid-turn (`compacting`), a tool
   * waits for the user's permission (`approval`) or answer (`input`), or the turn
   * failed (`error`). v0.0.43: a failed turn carries the `reason` the source states
   * (out of quota, rate limited, signed out, …) when its error text or code says so.
   */
  | { type: 'status'; status: TranscriptStatus; reason?: StopReason }
  /**
   * A sub-agent starts. `agentId` names the agent that spawned it (the primary
   * when absent); label, role and model are only what the source states.
   */
  | { type: 'subagent.spawn'; subagentId: string; label?: string; role?: string; model?: string }
);

export type TranscriptStatus = 'thinking' | 'compacting' | 'approval' | 'input' | 'error';

/**
 * Context a transcript states for its lead agent (v0.0.48): the prompt size of its latest model request
 * (the source's own usage report, cache included), the window the source states when it does, and the
 * context compactions the transcript records. Absent when the transcript reports no usage.
 */
export interface TranscriptContext {
  usedTokens: number;
  windowTokens?: number;
  compactions: number;
}

export const STEP_TEXT_LIMIT = 20_000;
export const STEP_OUTPUT_LIMIT = 4_000;
const MAX_STEPS = 20_000;

type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';

export function stepTime(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? (Math.abs(value) < 1e12 ? value * 1000 : value) : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

/** File base name, for targets: never a full path. */
export function fileTarget(path: string): string {
  return safeLabel(path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path, 120);
}

const SHELLS = /^(?:\/\S*\/)?(?:ba|z|da|k|fi)?sh$|^(?:\/\S*\/)?(?:pwsh|powershell|cmd)(?:\.exe)?$/i;

/** Flatten `["bash", "-lc", "…"]` style command arrays into the command text. */
function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return '';
  const parts = value as string[];
  if (parts.length >= 3 && SHELLS.test(parts[0]!) && /^-\w*c$|^\/c$/i.test(parts[1]!)) return parts.slice(2).join(' ');
  return parts.join(' ');
}

/** The head of a command: the first segment that is not a `cd`, at most three words. */
export function commandHead(command: string): string {
  const firstLine = command.trim().split(/\r?\n/)[0] ?? '';
  const segments = firstLine.split(/\s*(?:&&|\|\||;|\|)\s*/).map(item => item.trim()).filter(Boolean);
  const segment = segments.find(item => !/^cd\s/.test(item)) ?? segments[0] ?? '';
  return safeLabel(segment.split(/\s+/).slice(0, 3).join(' '), 80);
}

/** Files named by an `apply_patch` envelope. */
function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim()).filter(Boolean);
}

const unquote = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try { return JSON.parse(trimmed); } catch { /* plain text */ }
  }
  return value;
};

/** Short target and command head for a tool call, from well-known argument names only. */
export function toolHints(tool: string, input: unknown): { target?: string; command?: string } {
  let args: unknown = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = input; }
  }
  if (typeof args === 'string') {
    const files = patchFiles(args);
    if (files.length) return { target: files.length > 1 ? `${fileTarget(files[0]!)} +${files.length - 1}` : fileTarget(files[0]!) };
    return /shell|bash|exec|command|terminal/i.test(tool) && args.trim() ? { command: commandHead(args) } : {};
  }
  const rawRecord = obj(args);
  const record: RecordValue = Object.fromEntries(Object.entries(rawRecord).map(([key, val]) => [key, unquote(val)]));
  const command = commandText(record.cmd ?? record.command ?? record.CommandLine);
  if (command.trim()) return { command: commandHead(command), target: commandHead(command) };
  const patch = str(record.input) || str(record.patch);
  if (patch) { const hints = toolHints(tool, patch); if (hints.target) return hints; }
  const file = [record.file_path, record.filePath, record.absolute_path, record.AbsolutePath, record.TargetFile, record.notebook_path, record.path, record.dir_path, record.DirectoryPath, record.SearchPath].find(value => typeof value === 'string' && value.trim());
  if (typeof file === 'string') return { target: fileTarget(file) };
  const url = str(record.url) || str(record.Url);
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\s@]*@)?([^/?#\s]+)/i.exec(url)?.[1];
  if (host) return { target: safeLabel(host, 120) };
  const subagent = Array.isArray(record.Subagents) ? obj(record.Subagents[0]) : {};
  const other = [record.pattern, record.query, record.Query, record.description, record.subagent_type, record.Role, subagent.Role, subagent.TypeName, record.toolSummary, record.toolAction].find(value => typeof value === 'string' && value.trim());
  return typeof other === 'string' ? { target: safeLabel(other, 80) } : {};
}

/** Tool output text, clipped and redacted. */
export function stepOutput(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value) ?? '';
  return text.trim() ? safeText(text, STEP_OUTPUT_LIMIT) : undefined;
}

/** Exit status a tool output states explicitly; `undefined` when it states none. */
export function statedSuccess(output: unknown): boolean | undefined {
  let value = output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) { try { value = JSON.parse(trimmed); } catch { /* text */ } }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = obj(value), metadata = obj(record.metadata);
    if (record.success === false || record.is_error === true) return false;
    const code = record.exit_code ?? record.exitCode ?? metadata.exit_code;
    if (typeof code === 'number') return code === 0;
    if (record.success === true) return true;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /(?:^|\n)(?:Exit code:|Process exited with code)\s*(-?\d+)/.exec(value);
  return match ? Number(match[1]) === 0 : undefined;
}

/** Visible text of a tool output (`{ output }` envelopes are unwrapped). */
export function outputText(output: unknown): unknown {
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{')) {
      try { const parsed = obj(JSON.parse(trimmed)); if (typeof parsed.output === 'string') return parsed.output; } catch { /* text */ }
    }
    return output;
  }
  const record = obj(output);
  return typeof record.content === 'string' ? record.content : typeof record.output === 'string' ? record.output : output;
}

/** Bounded step list builder that clips text and keeps positions unique. */
export class StepList {
  readonly steps: TranscriptStep[] = [];
  private seen = new Set<string>();
  push(step: TranscriptStep): void {
    if (this.steps.length >= MAX_STEPS || this.seen.has(step.pos)) return;
    this.seen.add(step.pos);
    if (step.type === 'prompt' || step.type === 'reply') {
      // A prompt may be only an image.
      if (!step.text.trim() && !(step.type === 'prompt' && step.attachments?.length)) return;
      step.text = safeText(step.text, STEP_TEXT_LIMIT);
    }
    if (step.type === 'subagent.spawn') {
      step.subagentId = safeLabel(step.subagentId, 160);
      if (!step.subagentId) return;
      for (const key of ['label', 'role', 'model'] as const) {
        if (step[key] === undefined) continue;
        const value = safeLabel(step[key], key === 'model' ? 120 : 160);
        if (value) step[key] = value; else delete step[key];
      }
    }
    if (step.type === 'tool.call' || step.type === 'tool.result') {
      if (step.callId !== undefined) { const id = safeLabel(step.callId, 160); if (id) step.callId = id; else delete step.callId; }
      if (step.type === 'tool.call') step.tool = safeLabel(step.tool, 120) || 'tool';
      else if (step.tool !== undefined) step.tool = safeLabel(step.tool, 120) || 'tool';
    }
    this.steps.push(step);
  }
}

/** A sub-agent's own transcript, merged into its lead's activity for live observation. */
export interface SubagentTranscript {
  /** Sub-agent identity in the merged steps (`agentId` of its steps). */
  id: string;
  /** The agent that spawned it; the primary agent when absent. */
  parentId?: string;
  label?: string;
  role?: string;
  /** Model the source names for the sub-agent; otherwise its first reply's model is used. */
  model?: string;
  /** Spawn time; defaults to its first step's time. */
  at?: string;
  steps: readonly TranscriptStep[];
}

/**
 * Merge sub-agent transcripts into the lead's steps in time order (stable for
 * equal or missing times). Each sub-agent is announced by a `subagent.spawn`
 * step and its steps are re-attributed to it; positions get a per-sub-agent
 * prefix, so they stay unique and stable across reads.
 */
export function mergeSubagentSteps(main: readonly TranscriptStep[], subagents: readonly SubagentTranscript[]): TranscriptStep[] {
  type Keyed = { step: TranscriptStep; time: number; lane: number; index: number };
  const keyed: Keyed[] = [];
  const timeOf = (value: string | undefined, fallback: number) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : fallback; };
  let time = -Infinity;
  main.forEach((step, index) => { time = Math.max(time, timeOf(step.at, time)); keyed.push({ step, time, lane: 0, index }); });
  subagents.forEach((sub, offset) => {
    const id = safeLabel(sub.id, 160);
    if (!id || id === 'primary') return;
    const lane = offset + 1, prefix = `S:${id}:`;
    const model = sub.model ?? sub.steps.find((step): step is Extract<TranscriptStep, { type: 'reply' }> => step.type === 'reply' && Boolean(step.model))?.model;
    const at = sub.at ?? sub.steps.find(step => step.at)?.at;
    let laneTime = timeOf(at, -Infinity);
    keyed.push({ step: { pos: `${prefix}spawn`, ...(at ? { at } : {}), ...(sub.parentId && sub.parentId !== 'primary' ? { agentId: sub.parentId } : {}), type: 'subagent.spawn', subagentId: id,
      ...(sub.label ? { label: sub.label } : {}), ...(sub.role ? { role: sub.role } : {}), ...(model ? { model } : {}) }, time: laneTime, lane, index: -1 });
    sub.steps.forEach((step, index) => {
      if (step.type === 'subagent.spawn') return;
      laneTime = Math.max(laneTime, timeOf(step.at, laneTime));
      keyed.push({ step: { ...step, pos: `${prefix}${step.pos}`, agentId: id }, time: laneTime, lane, index });
    });
  });
  keyed.sort((a, b) => a.time - b.time || (a.lane === b.lane ? a.index - b.index : a.lane - b.lane));
  return keyed.map(item => item.step);
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const decodedSize = (base64: string) => Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0));
const baseName = (value: string) => value.split(/[\\/]/).pop()?.split('?')[0] ?? '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** One image given as a `data:` URL, plain base64 with a media type, a URL or a local path. */
export function imageAttachment(source: { url?: string; base64?: string; mimeType?: string; name?: string }, index: number): StepAttachment {
  let mimeType = source.mimeType?.toLowerCase(), base64 = source.base64;
  const data = source.url?.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data) { mimeType = data[1]!.toLowerCase(); base64 = data[2]; }
  const extension = mimeType ? IMAGE_EXTENSIONS[mimeType] : undefined;
  const named = safeLabel(source.name ?? (source.url && !data ? baseName(source.url) : ''), 200);
  const name = named || `image-${index + 1}${extension ? `.${extension}` : ''}`;
  const size = base64 ? decodedSize(base64) : 0;
  const inline = base64 && extension && size > 0 && size <= MAX_INLINE_IMAGE_BYTES && /^[A-Za-z0-9+/=\s]+$/.test(base64.slice(0, 4096));
  return { name, kind: 'image', size, ...(mimeType ? { mimeType } : {}), ...(inline ? { data: base64!.replace(/\s+/g, '') } : {}) };
}

/**
 * Files attached to a prompt in the content-part shapes the supported apps record: Claude `image` and
 * `document` blocks, Codex `input_image` parts, OpenAI-style `image_url` parts (Hermes) and Gemini
 * `inlineData` / `fileData` parts. Text parts are not attachments.
 */
export function promptAttachments(parts: unknown): StepAttachment[] {
  const out: StepAttachment[] = [];
  for (const raw of Array.isArray(parts) ? parts : []) {
    if (out.length >= MAX_STEP_ATTACHMENTS) break;
    const part = record(raw), type = text(part.type);
    if (type === 'image') {
      const source = record(part.source);
      out.push(imageAttachment(text(source.type) === 'base64' ? { base64: text(source.data), mimeType: text(source.media_type) } : { url: text(source.url) }, out.length));
    } else if (type === 'document') {
      const source = record(part.source), media = text(source.media_type);
      const name = safeLabel(text(part.title), 200) || `document-${out.length + 1}${media === 'application/pdf' ? '.pdf' : media === 'text/plain' ? '.txt' : ''}`;
      const size = text(source.type) === 'base64' ? decodedSize(text(source.data)) : text(source.data).length;
      out.push({ name, kind: media.startsWith('text/') || text(source.type) === 'text' ? 'text' : 'file', size, ...(media ? { mimeType: media } : {}) });
    } else if (type === 'input_image' || type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : text(record(part.image_url).url);
      if (url) out.push(imageAttachment({ url }, out.length));
    } else if (part.inlineData || part.inline_data) {
      const inline = record(part.inlineData ?? part.inline_data), mimeType = text(inline.mimeType ?? inline.mime_type);
      if (mimeType.startsWith('image/')) out.push(imageAttachment({ base64: text(inline.data), mimeType }, out.length));
      else out.push({ name: `file-${out.length + 1}`, kind: mimeType.startsWith('text/') ? 'text' : 'file', size: decodedSize(text(inline.data)), ...(mimeType ? { mimeType } : {}) });
    } else if (part.fileData || part.file_data) {
      const file = record(part.fileData ?? part.file_data), mimeType = text(file.mimeType ?? file.mime_type), uri = text(file.fileUri ?? file.file_uri);
      out.push(mimeType.startsWith('image/') ? imageAttachment({ url: uri, mimeType }, out.length)
        : { name: safeLabel(baseName(uri), 200) || `file-${out.length + 1}`, kind: mimeType.startsWith('text/') ? 'text' : 'file', size: 0, ...(mimeType ? { mimeType } : {}) });
    }
  }
  return out;
}

/** Codex `user_message` events list pasted images as `data:` URLs and attached files as local paths. */
export function codexEventAttachments(payload: Record<string, unknown>): StepAttachment[] {
  const out: StepAttachment[] = [];
  for (const url of Array.isArray(payload.images) ? payload.images : []) if (typeof url === 'string' && out.length < MAX_STEP_ATTACHMENTS) out.push(imageAttachment({ url }, out.length));
  for (const path of Array.isArray(payload.local_images) ? payload.local_images : []) if (typeof path === 'string' && out.length < MAX_STEP_ATTACHMENTS) out.push(imageAttachment({ url: path }, out.length));
  return out;
}
