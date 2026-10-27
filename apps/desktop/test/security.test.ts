import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, MEDIA_TYPES, isAllowedAppUrl, parseByteRange, parseDevServerUrl, resolveAppFile } from '../src/security';

describe('desktop security rules', () => {
  const root = path.resolve('/srv/extalia-web');
  it('allows embedded model image textures without enabling blob scripts or external images', () => {
    const directives = new Map(CONTENT_SECURITY_POLICY.split('; ').map(directive => { const [name, ...values] = directive.split(' '); return [name, values]; }));
    expect(directives.get('img-src')).toContain('blob:');
    expect(directives.get('connect-src')).toContain('blob:');
    expect(directives.get('script-src')).not.toContain('blob:');
    expect(directives.get('img-src')).not.toContain('https:');
  });

  it('lets the Splash play its loop from the app scheme only', () => {
    const directives = new Map(CONTENT_SECURITY_POLICY.split('; ').map(directive => { const [name, ...values] = directive.split(' '); return [name, values]; }));
    expect(directives.get('media-src')).toEqual(["'self'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
  });

  it('serves the Splash video types in single byte ranges', () => {
    expect(MEDIA_TYPES['.webm']).toBe('video/webm');
    expect(MEDIA_TYPES['.mp4']).toBe('video/mp4');
    expect(parseByteRange(null, 10)).toBeUndefined();
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
    expect(parseByteRange('bytes=10-', 10)).toBeNull();
  });

  it('serves files inside the web build only', () => {
    expect(resolveAppFile(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'));
    expect(resolveAppFile(root, '/../secrets.txt')).toBeUndefined();
    expect(resolveAppFile(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(resolveAppFile(root, '/%E0%A4%A')).toBeUndefined();
  });

  it('accepts only loopback HTTP development servers', () => {
    expect(parseDevServerUrl('http://127.0.0.1:5180')?.origin).toBe('http://127.0.0.1:5180');
    expect(parseDevServerUrl('https://127.0.0.1:5180')).toBeUndefined();
    expect(parseDevServerUrl('http://example.com:5180')).toBeUndefined();
    expect(parseDevServerUrl('not a url')).toBeUndefined();
  });

  it('allows navigation to the app and the approved dev server only', () => {
    const dev = parseDevServerUrl('http://127.0.0.1:5180');
    expect(isAllowedAppUrl('extalia://app/index.html')).toBe(true);
    expect(isAllowedAppUrl('http://127.0.0.1:5180/', dev)).toBe(true);
    expect(isAllowedAppUrl('http://127.0.0.1:5180/')).toBe(false);
    expect(isAllowedAppUrl('https://example.com/')).toBe(false);
    expect(isAllowedAppUrl('extalia://other/index.html')).toBe(false);
  });
});
