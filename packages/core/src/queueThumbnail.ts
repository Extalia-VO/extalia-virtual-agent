const PNG_PREFIX = 'data:image/png;base64,';
const MAX_ENCODED_BYTES = 96 * 1024;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bounded inline PNG header validation shared by queue hosts and presentation. No media is loaded. */
export function safeQueueThumbnail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > PNG_PREFIX.length + MAX_ENCODED_BYTES || !value.startsWith(PNG_PREFIX)) return undefined;
  const encoded = value.slice(PNG_PREFIX.length);
  if (encoded.length < 32 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  // Canonical padding also requires unused bits in the final sextet to be zero.
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (padding && (BASE64.indexOf(encoded[encoded.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0) return undefined;
  const header: number[] = [];
  for (let offset = 0; offset < 32; offset += 4) {
    const a = BASE64.indexOf(encoded[offset]!), b = BASE64.indexOf(encoded[offset + 1]!);
    const c = BASE64.indexOf(encoded[offset + 2]!), d = BASE64.indexOf(encoded[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined;
    header.push(a << 2 | b >> 4, (b & 15) << 4 | c >> 2, (c & 3) << 6 | d);
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (signature.some((byte, index) => header[index] !== byte)) return undefined;
  const width = header[16]! * 0x1000000 + header[17]! * 0x10000 + header[18]! * 0x100 + header[19]!;
  const height = header[20]! * 0x1000000 + header[21]! * 0x10000 + header[22]! * 0x100 + header[23]!;
  return width > 0 && height > 0 && width <= 1024 && height <= 1024 && width * height <= 262_144 ? value : undefined;
}
