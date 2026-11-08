import { StringDecoder } from 'node:string_decoder';
import { OUTPUT_LIMIT } from './shared.js';

export const MAX_READ_BYTES = 5 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_LENGTH = 2000;

/** The scanner owns this handle and closes it before resolving or rejecting. */
interface TextPageHandle {
  stat(): Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>;
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

type TextPage =
  | { kind: 'oversized'; bytes: number }
  | { kind: 'directory' }
  | { kind: 'nonregular' }
  | { kind: 'binary'; bytes: number }
  | { kind: 'text'; totalLines: number; shown: number; output: string };

/** Scan the whole bounded file for line totals, retaining only the visible page. */
export async function readTextPage(
  handle: TextPageHandle,
  { offset, limit, signal }: { offset: number; limit: number; signal: AbortSignal },
): Promise<TextPage> {
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    signal.throwIfAborted();
    if (info.isDirectory()) return { kind: 'directory' };
    if (!info.isFile()) return { kind: 'nonregular' };
    if (info.size > MAX_READ_BYTES) return { kind: 'oversized', bytes: info.size };
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    // Unlike TextDecoder's default behavior, StringDecoder retains a UTF-8 BOM.
    const decoder = new StringDecoder('utf8');
    const lines: { prefix: string; length: number }[] = [];
    let bytes = 0;
    let binary = false;
    let totalLines = 0;
    let lineLength = 0;
    let prefix = '';
    let lastWasCR = false;
    let candidateSize = 0;
    let retain = true;

    const wantsLine = () => retain && totalLines + 1 >= offset && lines.length < limit;
    const append = (chunk: string, start: number, end: number) => {
      if (end === start) return;
      lineLength += end - start;
      lastWasCR = chunk.charCodeAt(end - 1) === 13;
      if (wantsLine() && prefix.length < MAX_LINE_LENGTH) {
        prefix += chunk.slice(start, Math.min(end, start + MAX_LINE_LENGTH - prefix.length));
      }
    };
    const finishLine = (newline: boolean) => {
      const length = lineLength - (newline && lastWasCR ? 1 : 0);
      if (wantsLine()) {
        const kept = prefix.slice(0, length);
        const renderedLength = kept.length + (length > MAX_LINE_LENGTH ? `… [line clipped, ${length} characters]`.length : 0);
        // Four digits, a tab and a newline are a lower bound on entry cost.
        // Once this cannot fit, no later candidate can be displayed either.
        if (lines.length && candidateSize + renderedLength + 6 > OUTPUT_LIMIT) retain = false;
        else {
          lines.push({ prefix: kept, length });
          candidateSize += renderedLength + 6;
        }
      }
      totalLines++;
      lineLength = 0;
      prefix = '';
      lastWasCR = false;
    };
    const scan = (chunk: string) => {
      let start = 0;
      while (start < chunk.length) {
        if (!wantsLine()) {
          // Outside the page, only count newlines. In a dense file this avoids
          // millions of prefix, clipping and output-budget checks.
          const stopAt = retain && lines.length < limit ? offset - 1 : Infinity;
          let end: number;
          let found = false;
          while (totalLines < stopAt && (end = chunk.indexOf('\n', start)) !== -1) {
            totalLines++;
            start = end + 1;
            found = true;
          }
          if (found) {
            lineLength = 0;
            prefix = '';
            lastWasCR = false;
          }
          if (totalLines < stopAt) {
            lineLength += chunk.length - start;
            if (start < chunk.length) lastWasCR = chunk.charCodeAt(chunk.length - 1) === 13;
            return;
          }
        }
        const end = chunk.indexOf('\n', start);
        if (end === -1) {
          append(chunk, start, chunk.length);
          return;
        }
        append(chunk, start, end);
        finishLine(true);
        start = end + 1;
      }
    };

    while (true) {
      signal.throwIfAborted();
      // The extra byte detects growth after stat without reading an unbounded file.
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_READ_BYTES + 1 - bytes), null);
      signal.throwIfAborted();
      if (!bytesRead) break;
      if (bytes < 8000 && buffer.subarray(0, Math.min(bytesRead, 8000 - bytes)).includes(0)) binary = true;
      bytes += bytesRead;
      if (bytes > MAX_READ_BYTES) return { kind: 'oversized', bytes };
      if (!binary) scan(decoder.write(buffer.subarray(0, bytesRead)));
    }
    if (binary) return { kind: 'binary', bytes };
    scan(decoder.end());
    // split(/\r?\n/) drops exactly one final empty entry, including for empty files.
    if (lineLength) finishLine(false);
    const end = Math.min(totalLines, offset - 1 + limit);
    const width = Math.max(4, String(end).length);
    const output: string[] = [];
    let size = 0;
    let shown = offset - 1;
    for (const [index, line] of lines.entries()) {
      const text = line.length > MAX_LINE_LENGTH ? `${line.prefix}… [line clipped, ${line.length} characters]` : line.prefix;
      const entry = `${String(offset + index).padStart(width)}\t${text}`;
      if (output.length && size + entry.length + 1 > OUTPUT_LIMIT) break;
      output.push(entry);
      size += entry.length + 1;
      shown = offset + index;
    }
    return { kind: 'text', totalLines, shown, output: output.join('\n') };
  } finally {
    await handle.close();
  }
}
