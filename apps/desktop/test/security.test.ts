import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedAppUrl, parseDevServerUrl, resolveAppFile } from '../src/security';

describe('desktop security rules', () => {
  const root = path.resolve('/srv/extalia-web');

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
