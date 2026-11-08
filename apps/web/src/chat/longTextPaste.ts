import { attachmentRejection, type PendingAttachment } from './attachments';

/** Match the host prompt ceiling. Inline file budgets remain bounded by the runtime. */
export const MESSAGE_TEXT_LIMIT = 100_000;
export const LONG_PASTE_THRESHOLD = 8_000;
export const PASTED_TEXT_TOTAL = 400_000;
const PART_CHARACTERS = 100_000;
let sequence = 0;

export function pastedValue(value: string, pasted: string, start: number, end: number): string {
  return value.slice(0, start) + pasted + value.slice(end);
}

/** Whole draft, not just its overflow, preserving selection order and Unicode exactly. */
export function longTextFiles(text: string, existing: readonly PendingAttachment[]): File[] | undefined {
  // Bytes conservatively bound the existing files' character cost, even before decoding.
  const used = existing.filter(chip => chip.kind === 'text').reduce((sum, chip) => sum + chip.size, 0);
  if (text.length + used > PASTED_TEXT_TOTAL) return undefined;
  const parts: File[] = [];
  const id = ++sequence;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + PART_CHARACTERS);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    const file = new File([text.slice(start, end)], `pasted-prompt-${id}-${parts.length + 1}.txt`, { type: 'text/plain;charset=utf-8' });
    if (attachmentRejection(file, existing.length + parts.length)) return undefined;
    parts.push(file);
    start = end;
  }
  return parts;
}
