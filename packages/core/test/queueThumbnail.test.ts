import { describe, expect, it } from 'vitest';
import { safeQueueThumbnail } from '../src/index.js';

const prefix = 'data:image/png;base64,';
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 163, 69, 153, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130);
function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const value = bytes[i]! << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    encoded += alphabet[value >>> 18]! + alphabet[value >>> 12 & 63]!
      + (i + 1 < bytes.length ? alphabet[value >>> 6 & 63]! : '=') + (i + 2 < bytes.length ? alphabet[value & 63]! : '=');
  }
  return encoded;
}
const thumbnail = (width = 1, height = 1, bytes = png.length) => {
  const image = new Uint8Array(bytes); image.set(png.subarray(0, bytes));
  new DataView(image.buffer).setUint32(16, width); new DataView(image.buffer).setUint32(20, height);
  return prefix + base64(image);
};

describe('safeQueueThumbnail', () => {
  it('returns a bounded canonical inline PNG unchanged', () => {
    const value = thumbnail();
    expect(safeQueueThumbnail(value)).toBe(value);
    expect(safeQueueThumbnail(thumbnail(1024, 256))).toBeDefined();
    expect(safeQueueThumbnail(thumbnail(512, 512))).toBeDefined();
  });
  it.each([[0, 1], [1, 0], [1025, 1], [1, 1025], [512, 513], [0xffffffff, 1]])('rejects dimensions %i by %i', (width, height) => {
    expect(safeQueueThumbnail(thumbnail(width, height))).toBeUndefined();
  });
  it('bounds the encoded ASCII payload before inspecting the base64 body', () => {
    const value = thumbnail(1, 1, 96 * 1024 / 4 * 3);
    expect(value.length - prefix.length).toBe(96 * 1024);
    expect(safeQueueThumbnail(value)).toBe(value);
    expect(safeQueueThumbnail(value + 'AAAA')).toBeUndefined();
  });
  it('rejects incorrect PNG signatures, chunk types and IHDR lengths', () => {
    for (const offset of [0, 7, 11, 12, 15]) {
      const image = png.slice(); image[offset] = image[offset]! ^ 1;
      expect(safeQueueThumbnail(prefix + base64(image))).toBeUndefined();
    }
  });
  it('rejects noncanonical or malformed base64 including nonzero padding bits', () => {
    const value = thumbnail(), body = value.slice(prefix.length);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const noncanonical = body.slice(0, -2) + alphabet[alphabet.indexOf(body.at(-2)!) | 1] + '=';
    for (const encoded of [body.slice(1), body + '=', body + '\n', body.replace('A', '%41'), 'AAAA=AAA', body.slice(0, -3) + '===', noncanonical]) {
      expect(safeQueueThumbnail(prefix + encoded)).toBeUndefined();
    }
    const doublePadding = thumbnail(1, 1, 70);
    expect(doublePadding.endsWith('==')).toBe(true);
    expect(safeQueueThumbnail(doublePadding)).toBe(doublePadding);
    expect(safeQueueThumbnail(doublePadding.slice(0, -3) + 'B==')).toBeUndefined();
  });
  it.each([undefined, null, 42, {}, '', 'https://example.com/image.png', 'file:///private/image.png',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,/9j/', 'data:image/png,raw',
    prefix + 'AAAA', thumbnail().replace('image/png', 'IMAGE/PNG')])('rejects unavailable, remote and other media (%j)', value => {
    expect(safeQueueThumbnail(value)).toBeUndefined();
  });
});
