import {
  ATTACHMENT_LIMITS as HOST_LIMITS, MAX_PROMPT_ATTACHMENTS, attachmentLimit, classifyAttachment, decodeAttachmentData, detectImageMimeType,
  type AgentHostApi, type AttachmentKind, type PromptAttachment, type PromptAttachmentInput,
} from '@extalia/platform';
import { errorMessage } from '../host/remote';

/**
 * Files attached to a prompt (v0.0.49). The UI checks limits before upload so the user gets a
 * friendly message at once; the host checks them again and its kind is the one that counts.
 * Each file uploads on its own with `uploadAttachment`; the prompt then names only the ids.
 */

export const MAX_ATTACHMENTS = MAX_PROMPT_ATTACHMENTS;
/** Per-file limits by kind: images, text-like files, and everything else (passed by name only). */
export const ATTACHMENT_LIMITS = { image: HOST_LIMITS.imageBytes, text: HOST_LIMITS.textBytes, file: HOST_LIMITS.fileBytes } as const;

export type { AttachmentKind, PromptAttachment, PromptAttachmentInput };

/**
 * The host methods the attachment flow uses. `AgentHostApi` satisfies it; the upload and remove
 * methods are optional so a host that predates them hides the attach button instead of failing.
 */
export type AttachmentHostApi = Pick<AgentHostApi, 'sendPrompt'> & Partial<Pick<AgentHostApi, 'uploadAttachment' | 'removeAttachment'>>;

/** The kind the browser-side check uses; the host classifies the same way from the declared type and extension. */
export function attachmentKind(name: string, mimeType: string): AttachmentKind {
  return classifyAttachment(name, mimeType).kind;
}

/** A short size: 812 B, 14 KB, 2.4 MB. */
export function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / MB;
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1).replace(/\.0$/, '')} MB`;
}

export type AttachmentRejection = { reason: 'count' } | { reason: 'size'; limit: number };

/** Why a file cannot be attached next to `existing` others, or `undefined` when it can. */
export function attachmentRejection(file: { name: string; type: string; size: number }, existing: number): AttachmentRejection | undefined {
  if (existing >= MAX_ATTACHMENTS) return { reason: 'count' };
  const limit = attachmentLimit(attachmentKind(file.name, file.type));
  return file.size > limit ? { reason: 'size', limit } : undefined;
}

export interface AttachmentPlan<F> {
  accepted: F[];
  rejected: { file: F; name: string; rejection: AttachmentRejection }[];
}

/**
 * Split files being added into those accepted (in order, up to the per-message limit) and
 * those rejected, each with its reason. Files over the limit are rejected by count.
 */
export function planAttachments<F extends { name: string; type: string; size: number }>(existing: number, files: readonly F[]): AttachmentPlan<F> {
  const plan: AttachmentPlan<F> = { accepted: [], rejected: [] };
  for (const file of files) {
    const rejection = attachmentRejection(file, existing + plan.accepted.length);
    if (rejection) plan.rejected.push({ file, name: file.name, rejection });
    else plan.accepted.push(file);
  }
  return plan;
}

/** The chip's state while a prompt is being sent: waiting, uploading, uploaded (has an id) or failed (retry keeps the id). */
export type AttachmentStatus = 'ready' | 'uploading' | 'uploaded' | 'failed';

export interface PendingAttachment {
  /** Local key for the chip. */
  key: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** Set once uploaded; retries reuse it. */
  attachmentId?: string;
  error?: string;
  /** Object URL for image thumbnails; revoked when the chip goes. */
  previewUrl?: string;
}

/** Bytes as base64 without building one huge string argument. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

/** Thrown after the first failed upload; the failed chip keeps its message and the others stay ready. */
export class AttachmentUploadError extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentUploadError'; }
}

/**
 * Upload the chips that have no id yet, in order, and return the ids in chip order. Each chip
 * reports its status through `patch`. Stops at the first failure so the user can retry.
 */
export async function uploadAttachments(
  host: AttachmentHostApi,
  sessionId: string,
  chips: readonly PendingAttachment[],
  patch: (key: string, change: Partial<PendingAttachment>) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const chip of chips) {
    if (chip.attachmentId) { ids.push(chip.attachmentId); continue; }
    if (!host.uploadAttachment) throw new AttachmentUploadError('Attachments are not available on this host.');
    patch(chip.key, { status: 'uploading', error: undefined });
    try {
      const data = await fileToBase64(chip.file);
      const uploaded = await host.uploadAttachment(sessionId, { name: chip.name, mimeType: chip.mimeType, data });
      patch(chip.key, { status: 'uploaded', attachmentId: uploaded.id });
      ids.push(uploaded.id);
    } catch (failure) {
      const message = errorMessage(failure);
      patch(chip.key, { status: 'failed', error: message });
      throw new AttachmentUploadError(message);
    }
  }
  return ids;
}

/** Send a prompt, with its attachment ids when there are any. */
export function sendPromptWithAttachments(host: AttachmentHostApi, sessionId: string, text: string, attachmentIds: readonly string[], learnSkill = false): Promise<void> {
  const options = { ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}), ...(learnSkill ? { learnSkill: true } : {}) };
  return Object.keys(options).length ? host.sendPrompt(sessionId, text, options) : host.sendPrompt(sessionId, text);
}

/**
 * An attachment as the transcript shows it: name, kind and size from the prompt event, never the contents.
 * `ref` names an image the host kept a private copy of (observed transcripts); `attachmentPreview` shows it.
 */
export interface AttachmentMetadata { name: string; kind: AttachmentKind; size: number; ref?: string }

/** Reads the attachment metadata a prompt event carries; anything malformed is dropped. */
export function promptAttachmentMetadata(value: unknown): AttachmentMetadata[] {
  if (!Array.isArray(value)) return [];
  const kinds: readonly string[] = ['image', 'text', 'file'];
  return value.slice(0, MAX_ATTACHMENTS).flatMap((entry): AttachmentMetadata[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== 'string' || !item.name.trim() || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
      || typeof item.kind !== 'string' || !kinds.includes(item.kind)) return [];
    const ref = typeof item.ref === 'string' && item.ref.length === 64 && /^[0-9a-f]{64}$/.test(item.ref) ? item.ref : undefined;
    return [{ name: item.name.slice(0, 200), kind: item.kind as AttachmentKind, size: Math.max(0, item.size), ...(ref ? { ref } : {}) }];
  });
}

/** A thumbnail owns its rendition; originals are opened and released only by an explicit viewer. */
export interface AttachmentPreviewLease {
  value: Promise<string | undefined>;
  original?(): Promise<string | undefined>;
  closeOriginal?(): void;
  release(): void;
}
export interface AttachmentPreviewLoader {
  /** Legacy explicit full-image request; passive thumbnails use acquire instead. */
  (ref: string): Promise<string | undefined>;
  acquire?(ref: string): AttachmentPreviewLease;
  dispose?(): void;
}
export const ATTACHMENT_PREVIEW_CACHE_LIMITS = { entries: 16, bytes: 16 * 1024 * 1024, thumbnailEdge: 192, fallbackEntries: 4 } as const;

type Thumbnail = { kind: 'ready'; blob: Blob } | { kind: 'unsupported' | 'invalid' };
/** One temporary decoded frame at a time; only a small rendition remains available for passive display. */
async function imageThumbnail(original: Blob): Promise<Thumbnail> {
  if (typeof createImageBitmap !== 'function' || (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined')) return { kind: 'unsupported' };
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(original);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) return { kind: 'invalid' };
    const scale = Math.min(1, ATTACHMENT_PREVIEW_CACHE_LIMITS.thumbnailEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return { kind: 'unsupported' };
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close(); bitmap = undefined;
    const blob = 'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob | null>(resolve => (canvas as HTMLCanvasElement).toBlob(resolve, 'image/png'));
    return blob ? { kind: 'ready', blob } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
  finally { bitmap?.close(); if (canvas) { canvas.width = 1; canvas.height = 1; } }
}

/**
 * One session/view's bounded cache. Retain compressed original Blobs plus ≤192px renditions, not
 * decoded full screenshots. Original URLs exist only for explicit viewers/direct callers. Reads and
 * rendition generation share one lane; unmounted queued work is skipped before asking the host.
 */
export function attachmentPreviewLoader(host: Partial<Pick<AgentHostApi, 'attachmentPreview'>>, sessionId: string): AttachmentPreviewLoader | undefined {
  if (!host.attachmentPreview) return undefined;
  const load = host.attachmentPreview.bind(host);
  interface Entry {
    ref: string; users: number; originalUsers: number; retired: boolean; fallback: boolean;
    value: Promise<string | undefined>; url?: string; originalUrl?: string; directUrl?: string; original?: Blob; bytes: number;
  }
  const entries = new Map<string, Entry>();
  let bytes = 0, disposed = false;
  let lane: Promise<void> = Promise.resolve();
  const retire = (entry: Entry) => {
    if (entry.retired) return;
    entry.retired = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (entry.originalUrl && entry.originalUrl !== entry.url) URL.revokeObjectURL(entry.originalUrl);
    if (entry.directUrl && entry.directUrl !== entry.url) URL.revokeObjectURL(entry.directUrl);
    bytes -= entry.bytes; entry.original = undefined;
    if (entries.get(entry.ref) === entry) entries.delete(entry.ref);
  };
  const evict = (except?: Entry, fallbackOnly = false): boolean => {
    const idle = [...entries.values()].find(entry => entry !== except && !entry.users && (!fallbackOnly || entry.fallback));
    if (!idle) return false;
    retire(idle); return true;
  };
  const originalUrl = (entry: Entry, direct = false): string | undefined => {
    if (entry.retired || !entry.original) return undefined;
    if (entry.fallback) return entry.url;
    try {
      return direct ? (entry.directUrl ??= URL.createObjectURL(entry.original)) : (entry.originalUrl ??= URL.createObjectURL(entry.original));
    } catch { return undefined; }
  };
  const ensure = (ref: string): Entry | undefined => {
    if (disposed || typeof ref !== 'string' || ref.length !== 64 || !/^[0-9a-f]{64}$/.test(ref)) return undefined;
    const cached = entries.get(ref);
    if (cached) { entries.delete(ref); entries.set(ref, cached); return cached; }
    while (entries.size >= ATTACHMENT_PREVIEW_CACHE_LIMITS.entries && evict()) { /* Idle URLs only. */ }
    if (entries.size >= ATTACHMENT_PREVIEW_CACHE_LIMITS.entries) return undefined;
    const entry: Entry = { ref, users: 0, originalUsers: 0, retired: false, fallback: false, value: Promise.resolve(undefined), bytes: 0 };
    entries.set(ref, entry);
    const work = lane.then(async () => {
      if (entry.retired || disposed) return undefined;
      try {
        const found = await load(sessionId, ref);
        if (!found || entry.retired || disposed) return undefined;
        const data = decodeAttachmentData(found.data, HOST_LIMITS.imageBytes);
        if (detectImageMimeType(data) !== found.mimeType) return undefined;
        const original = new Blob([Uint8Array.from(data)], { type: found.mimeType });
        const thumbnail = await imageThumbnail(original);
        if (thumbnail.kind === 'invalid' || entry.retired || disposed) return undefined;
        if (thumbnail.kind === 'unsupported') {
          // Older browsers keep at most four full-image fallbacks, never sixteen large decoded views.
          while ([...entries.values()].filter(item => item.fallback).length >= ATTACHMENT_PREVIEW_CACHE_LIMITS.fallbackEntries && evict(entry, true)) { /* Idle fallbacks only. */ }
          if ([...entries.values()].filter(item => item.fallback).length >= ATTACHMENT_PREVIEW_CACHE_LIMITS.fallbackEntries) return undefined;
        }
        const retained = original.size + (thumbnail.kind === 'ready' ? thumbnail.blob.size : 0);
        while (bytes + retained > ATTACHMENT_PREVIEW_CACHE_LIMITS.bytes && evict(entry)) { /* Preserve active previews. */ }
        if (bytes + retained > ATTACHMENT_PREVIEW_CACHE_LIMITS.bytes) return undefined;
        entry.bytes = retained; bytes += retained; entry.original = original; entry.fallback = thumbnail.kind === 'unsupported';
        entry.url = URL.createObjectURL(thumbnail.kind === 'ready' ? thumbnail.blob : original);
        return entry.url;
      } catch { return undefined; }
    }).then(url => { if (!url) retire(entry); return url; });
    entry.value = work;
    lane = work.then(() => undefined, () => undefined);
    return entry;
  };
  const loader: AttachmentPreviewLoader = async ref => {
    const entry = ensure(ref);
    return entry && await entry.value ? originalUrl(entry, true) : undefined;
  };
  loader.acquire = ref => {
    const entry = ensure(ref);
    if (!entry) return { value: Promise.resolve(undefined), release: () => undefined };
    entry.users++;
    let released = false, originalOpen = false;
    const closeOriginal = () => {
      if (!originalOpen) return;
      originalOpen = false; entry.originalUsers--;
      if (!entry.originalUsers && entry.originalUrl) { URL.revokeObjectURL(entry.originalUrl); entry.originalUrl = undefined; }
    };
    return { value: entry.value, original: async () => {
      if (released || !await entry.value || released) return undefined;
      const url = originalUrl(entry);
      if (url && !originalOpen) { originalOpen = true; entry.originalUsers++; }
      return url;
    }, closeOriginal, release: () => {
      if (released) return;
      released = true; closeOriginal(); entry.users--; if (!entry.users) retire(entry);
    } };
  };
  loader.dispose = () => { disposed = true; for (const entry of entries.values()) if (!entry.users) retire(entry); };
  return loader;
}
