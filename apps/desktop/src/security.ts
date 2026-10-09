/**
 * Pure navigation, file-serving and IPC rules for the Desktop shell, kept free of
 * Electron imports so they can be unit tested.
 */
import { isAgentHostMethod, type AgentHostMethod } from '@extalia/platform';
import path from 'node:path';

export const APP_SCHEME = 'extalia';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
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
