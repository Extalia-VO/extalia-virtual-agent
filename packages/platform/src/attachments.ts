/**
 * Files attached to a prompt (v0.0.49). The UI sends each file with `uploadAttachment`,
 * then names the uploaded ids in `sendPrompt`. Pure functions only: the host, the Bridge,
 * Desktop and the Web client all use them, so this module imports nothing from Node or the DOM.
 */

/** A file as the UI sends it: base64 data, the name as the user sees it, and the browser's type guess. */
export interface PromptAttachmentInput {
  name: string;
  mimeType: string;
  /** Base64 (standard alphabet, padded). */
  data: string;
}

export interface PromptAttachment {
  id: string;
  /** Sanitized: no folders, no control characters, at most 120 characters. */
  name: string;
  mimeType: string;
  size: number;
  /** `image` (png, jpeg, webp, gif; sent to the model), `text` (inlined into the prompt), `file` (stored, named only). */
  kind: 'image' | 'text' | 'file';
}

export const MAX_PROMPT_ATTACHMENTS = 10;
export const ATTACHMENT_LIMITS = {
  /** Per file, by kind. */
  imageBytes: 5 * 1024 * 1024,
  textBytes: 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  /** Pending attachments one session keeps before the oldest must be sent or removed. */
  pendingPerSession: 40,
  nameLength: 120,
} as const;

export const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{24}$/;

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** An attached image the host keeps a private copy of, for showing in the app (base64 bytes). */
export interface AttachmentPreview {
  mimeType: ImageMimeType;
  data: string;
}
export const IMAGE_MIME_TYPES: readonly ImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const IMAGE_EXTENSIONS = new Map<string, ImageMimeType>([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']]);

/** Extensions read as text when the declared type is missing or generic (or is text already). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'zsh', 'fish', 'sql', 'graphql', 'gql', 'vue', 'svelte', 'lua', 'pl', 'r', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'clj', 'tf', 'proto', 'diff', 'patch',
]);
const TEXT_APPLICATION_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/x-sh', 'application/sql', 'application/csv', 'application/x-ndjson']);

/** Credential files (environment files, keys, package-manager tokens) are never attached: they would reach the model. */
export function isCredentialFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? '';
  return /^\.env(\..*)?$/i.test(base)
    || /\.(pem|key|p12|pfx|kdbx|keystore|jks)$/i.test(base)
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base)
    || /^\.(npmrc|netrc|pypirc|git-credentials|pgpass|docker\/config\.json)$/i.test(base)
    || /^(credentials|secrets?)(\.(json|ya?ml|txt|toml|ini))?$/i.test(base);
}

/**
 * A safe file name for display and for the model: the last path segment only, without control characters or
 * characters that are unsafe in paths, no leading dots, at most `ATTACHMENT_LIMITS.nameLength` characters
 * (the extension is kept when it is cut).
 */
export function sanitizeAttachmentName(raw: string): string {
  const last = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  let name = last.normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  if (!name) return 'attachment';
  if (name.length > ATTACHMENT_LIMITS.nameLength) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${name.slice(0, ATTACHMENT_LIMITS.nameLength - extension.length)}${extension}`;
  }
  return name;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** The type a browser declared, normalized: lowercase, no parameters, `image/jpg` read as `image/jpeg`. */
export function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const type = value.split(';')[0]!.trim().toLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';
  return /^[a-z0-9.+-]{1,50}\/[a-z0-9.+-]{1,100}$/.test(type) ? type : '';
}

export type AttachmentKind = PromptAttachment['kind'];

/**
 * The kind a file is handled as, from its declared type and extension (the host checks the bytes next).
 * Images need a supported type; text needs a text type or a text extension and a declared type that is not binary.
 */
export function classifyAttachment(name: string, mimeType: unknown): { kind: AttachmentKind; mimeType: string } {
  const extension = extensionOf(name);
  const declared = normalizeMimeType(mimeType);
  const generic = !declared || declared === 'application/octet-stream';
  if (IMAGE_MIME_TYPES.includes(declared as ImageMimeType)) return { kind: 'image', mimeType: declared };
  if (generic && IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', mimeType: IMAGE_EXTENSIONS.get(extension)! };
  if (declared.startsWith('text/') || TEXT_APPLICATION_TYPES.has(declared)) return { kind: 'text', mimeType: declared };
  // Code and config files: browsers often send no type, `application/…` or `video/mp2t` (for `.ts`).
  if (TEXT_EXTENSIONS.has(extension) && (generic || declared === 'video/mp2t' || declared.startsWith('application/'))) {
    return { kind: 'text', mimeType: extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain' };
  }
  return { kind: 'file', mimeType: declared || 'application/octet-stream' };
}

/** Byte limit for a kind. */
export function attachmentLimit(kind: AttachmentKind): number {
  return kind === 'image' ? ATTACHMENT_LIMITS.imageBytes : kind === 'text' ? ATTACHMENT_LIMITS.textBytes : ATTACHMENT_LIMITS.fileBytes;
}

/** The largest base64 text one upload may carry (every kind is at most 10 MB). */
export const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4;
/** The largest request body an upload needs: its base64 data plus the JSON envelope and the name. */
export const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_BASE64_CHARS + 4 * 1024;
/** Request header a client sends with an upload so the Bridge admits its larger body; other calls keep the normal limit. */
export const ATTACHMENT_BODY_HEADER = 'x-extalia-body';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Web and Node globals, typed here because this package is compiled without DOM or Node typings. */
const globals = globalThis as unknown as {
  atob(value: string): string;
  TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(bytes: Uint8Array): string };
};

/** Strict base64 decode with a size bound; throws an error whose message is safe to show. */
export function decodeAttachmentData(data: string, maxBytes = ATTACHMENT_LIMITS.fileBytes): Uint8Array {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) throw new Error('The file data is not valid base64.');
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error('The file is too large.');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = (data.length / 4) * 3 - padding;
  if (size > maxBytes) throw new Error('The file is too large.');
  const binary = globals.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The image type the first bytes announce (PNG, JPEG, WebP, GIF), or undefined. */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Whether bytes are UTF-8 text without NUL bytes (binary files fail this). */
export function isReadableText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try { new globals.TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/**
 * Check an upload from a client: its shape, a bounded base64 payload, and a clean name. Errors are safe to show.
 * Kind-specific limits and the file's bytes are checked by the host, which stores the file.
 */
export function normalizeAttachmentUpload(raw: unknown): PromptAttachmentInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid file upload.');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!['name', 'mimeType', 'data'].includes(key)) throw new Error('Invalid file upload.');
  if (typeof value.name !== 'string' || value.name.length > 1000) throw new Error('The file needs a name.');
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') throw new Error('The file type must be text.');
  if (typeof value.data !== 'string' || value.data.length > MAX_ATTACHMENT_BASE64_CHARS) throw new Error('The file is too large. Images up to 5 MB, text files up to 1 MB, other files up to 10 MB.');
  return { name: value.name, mimeType: typeof value.mimeType === 'string' ? value.mimeType : '', data: value.data };
}

/** `sendPrompt` options from a client: up to ten attachment ids, each well formed and unique. Errors are safe to show. */
export function normalizePromptAttachmentIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid prompt options.');
  const ids = (raw as { attachmentIds?: unknown }).attachmentIds;
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new Error('The attachments must be a list.');
  if (ids.length > MAX_PROMPT_ATTACHMENTS) throw new Error(`Attach up to ${MAX_PROMPT_ATTACHMENTS} files per prompt.`);
  for (const id of ids) if (typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id)) throw new Error('One of the attached files is not valid. Attach it again.');
  if (new Set(ids).size !== ids.length) throw new Error('A file was attached twice.');
  return [...ids];
}
