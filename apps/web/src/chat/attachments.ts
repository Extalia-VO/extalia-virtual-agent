import {
  ATTACHMENT_LIMITS as HOST_LIMITS, MAX_PROMPT_ATTACHMENTS, attachmentLimit, classifyAttachment,
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
export function sendPromptWithAttachments(host: AttachmentHostApi, sessionId: string, text: string, attachmentIds: readonly string[]): Promise<void> {
  return attachmentIds.length ? host.sendPrompt(sessionId, text, { attachmentIds: [...attachmentIds] }) : host.sendPrompt(sessionId, text);
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
  return value.flatMap((entry): AttachmentMetadata[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.size !== 'number' || typeof item.kind !== 'string' || !kinds.includes(item.kind)) return [];
    const ref = typeof item.ref === 'string' && /^[0-9a-f]{64}$/.test(item.ref) ? item.ref : undefined;
    return [{ name: item.name.slice(0, 200), kind: item.kind as AttachmentKind, size: Math.max(0, item.size), ...(ref ? { ref } : {}) }];
  });
}

/** Loads an attached image by its reference as an object URL; `undefined` when the host has no copy. */
export type AttachmentPreviewLoader = (ref: string) => Promise<string | undefined>;

/**
 * A preview loader for one session: each image is fetched once and kept as an object URL while the page
 * lives (they are small and few), so re-renders and reopened dialogs do not fetch again.
 */
export function attachmentPreviewLoader(host: Partial<Pick<AgentHostApi, 'attachmentPreview'>>, sessionId: string): AttachmentPreviewLoader | undefined {
  if (!host.attachmentPreview) return undefined;
  const load = host.attachmentPreview.bind(host);
  return ref => {
    const key = `${sessionId}:${ref}`;
    let pending = previews.get(key);
    if (!pending) {
      pending = load(sessionId, ref).then(found => {
        if (!found) return undefined;
        const bytes = Uint8Array.from(atob(found.data), char => char.charCodeAt(0));
        return URL.createObjectURL(new Blob([bytes], { type: found.mimeType }));
      }, () => undefined);
      previews.set(key, pending);
      // A failed or missing preview may appear later (the transcript is still being read).
      void pending.then(url => { if (!url) previews.delete(key); });
    }
    return pending;
  };
}
const previews = new Map<string, Promise<string | undefined>>();
