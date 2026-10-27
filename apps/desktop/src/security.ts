/**
 * Pure navigation, file-serving and IPC rules for the Desktop shell, kept free of
 * Electron imports so they can be unit tested.
 */
import { isAgentHostMethod, MAX_ATTACHMENT_BASE64_CHARS, type AgentHostMethod } from '@extalia/platform';
import path from 'node:path';

export const APP_SCHEME = 'extalia';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // GLTFLoader decodes embedded textures from local object URLs.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // The Splash plays its pre-rendered office loop from the app's own files.
  "media-src 'self'",
  "connect-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Accept a development server URL only when it is plain HTTP on the loopback interface. */
export function parseDevServerUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.protocol === 'http:' && loopback ? url : undefined;
  } catch {
    return undefined;
  }
}

/** True for URLs the window may display: the bundled app, or the approved dev server. */
export function isAllowedAppUrl(value: string, devServer?: URL): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST) return true;
    return Boolean(devServer && url.origin === devServer.origin);
  } catch {
    return false;
  }
}

/** Only the app's own pages may call into the main process. */
export function isTrustedSender(senderUrl: string | undefined, devServer?: URL): boolean {
  return Boolean(senderUrl && isAllowedAppUrl(senderUrl, devServer));
}

/** Validate an agent host call from the renderer before it reaches the host. Errors are safe to show. */
export function parseAgentCall(senderUrl: string | undefined, devServer: URL | undefined, method: unknown, args: unknown): { method: AgentHostMethod; args: unknown[] } {
  if (!isTrustedSender(senderUrl, devServer)) throw new Error('Untrusted sender.');
  // The whitelist keeps `subscribe` and inherited properties such as `constructor` out of reach.
  if (!isAgentHostMethod(method)) throw new Error('Unknown agent host method.');
  if (!Array.isArray(args)) throw new Error('Agent host arguments must be an array.');
  // A file upload is the only call with a large payload; its base64 data is bounded before it reaches the host.
  if (method === 'uploadAttachment') {
    const file = args[1];
    const data = typeof file === 'object' && file !== null ? (file as { data?: unknown }).data : undefined;
    if (typeof data === 'string' && data.length > MAX_ATTACHMENT_BASE64_CHARS) {
      throw new Error('The file is too large. Images up to 5 MB, text files up to 1 MB, other files up to 10 MB.');
    }
  }
  return { method, args };
}

/**
 * Map an app-protocol request path to a file inside the web build. Returns
 * undefined for anything that would escape the build directory.
 */
export function resolveAppFile(webRoot: string, requestPath: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return undefined; }
  if (decoded.includes('\0')) return undefined;
  const relative = decoded.replace(/^[/\\]+/, '') || 'index.html';
  const root = path.resolve(webRoot);
  const file = path.resolve(root, relative);
  return file.startsWith(root + path.sep) ? file : undefined;
}

/** Media the app scheme serves in byte ranges (the Splash loop); other files go through the file loader. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = { '.webm': 'video/webm', '.mp4': 'video/mp4' };

/**
 * One `bytes=` range of a file of `size` bytes, as inclusive offsets. `undefined` means serve the
 * whole file (no header, several ranges or another unit); `null` means unsatisfiable (416).
 */
export function parseByteRange(header: string | null | undefined, size: number): { start: number; end: number } | null | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : null;
}
