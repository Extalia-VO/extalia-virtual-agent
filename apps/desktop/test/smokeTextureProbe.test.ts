import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { failedTextureUrls, textureProbeScript } from '../src/smokeTextureProbe';

const url = 'blob:extalia://app/00000000-0000-4000-8000-000000000000';
function probe(fail: 'fetch' | 'decode' | null) {
  const bytes = new Uint8Array([1, 2, 3]);
  const close = vi.fn();
  const fetch = vi.fn(async () => {
    if (fail === 'fetch') throw new TypeError('Blob is no longer available');
    return { ok: true, blob: async () => new Blob([bytes], { type: 'image/png' }) };
  });
  const createImageBitmap = vi.fn(async () => {
    if (fail === 'decode') throw new Error('Decoder rejected source image');
    return { width: 2, height: 3, close };
  });
  const run = () => runInNewContext(textureProbeScript([`GLTFLoader: Couldn't load texture ${url}`]), { fetch, createImageBitmap, crypto: webcrypto, Uint8Array, AbortController, setTimeout, clearTimeout }) as Promise<Record<string, unknown>[]>;
  return { run, fetch, createImageBitmap, close, bytes };
}

describe('strict smoke texture failure diagnostics', () => {
  it('accepts only bounded app-owned blob UUIDs, deduplicating errors without visiting arbitrary URLs', () => {
    expect(failedTextureUrls([url, url, 'https://example.com/source.png', 'blob:https://example.com/00000000-0000-4000-8000-000000000000', 'file:///private/source'])).toEqual([url]);
    expect(failedTextureUrls(Array.from({ length: 20 }, (_, i) => url.replace('000000000000', String(i).padStart(12, '0'))))).toHaveLength(8);
  });

  it('records fetch failure separately from decoder failure', async () => {
    const f = probe('fetch');
    expect(await f.run()).toEqual([{ url, stage: 'fetch', error: 'TypeError: Blob is no longer available' }]);
    expect(f.createImageBitmap).not.toHaveBeenCalled();
  });

  it('binds a decoder failure to the exact source bytes without emitting the payload', async () => {
    const f = probe('decode'), result = await f.run();
    expect(result).toEqual([{ url, bytes: 3, mime: 'image/png', sha256: createHash('sha256').update(f.bytes).digest('hex'), stage: 'decode', error: 'Error: Decoder rejected source image' }]);
    expect(f.createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  });

  it('labels a later successful decode as diagnostics and closes its bitmap', async () => {
    const f = probe(null), result = await f.run();
    expect(result[0]).toMatchObject({ result: 'decodes-on-probe', width: 2, height: 3 });
    expect(f.close).toHaveBeenCalledOnce();
  });
});
