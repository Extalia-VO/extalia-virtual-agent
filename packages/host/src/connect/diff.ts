/**
 * A small unified diff for the "dry run" output. Configuration files are short,
 * so a line-based LCS on the changed middle (after trimming the common head and
 * tail) is enough; oversized middles fall back to one replace hunk.
 */

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;

type Op = { kind: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function operations(before: string[], after: string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const ops: Op[] = before.slice(0, head).map(line => ({ kind: ' ', line }));
  if (a.length * b.length > MAX_CELLS) {
    for (const line of a) ops.push({ kind: '-', line });
    for (const line of b) ops.push({ kind: '+', line });
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] as number) + 1 : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i] as string }); i++; j++; }
      else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) ops.push({ kind: '-', line: a[i++] as string });
      else ops.push({ kind: '+', line: b[j++] as string });
    }
    while (i < a.length) ops.push({ kind: '-', line: a[i++] as string });
    while (j < b.length) ops.push({ kind: '+', line: b[j++] as string });
  }
  for (const line of before.slice(before.length - tail)) ops.push({ kind: ' ', line });
  return ops;
}

/** Unified diff of two texts; the empty string when they are equal. */
export function unifiedDiff(before: string, after: string, labels: { from: string; to: string }): string {
  if (before === after) return '';
  const ops = operations(splitLines(before), splitLines(after));
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter(index => index >= 0);
  if (!changed.length) return '';

  // Group changes whose context windows touch.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT), end = Math.min(ops.length, index + CONTEXT + 1);
    const last = hunks.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  const lines = [`--- ${labels.from}`, `+++ ${labels.to}`];
  for (const [start, end] of hunks) {
    let oldStart = 1, newStart = 1;
    for (const op of ops.slice(0, start)) { if (op.kind !== '+') oldStart++; if (op.kind !== '-') newStart++; }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter(op => op.kind !== '+').length, newCount = slice.filter(op => op.kind !== '-').length;
    lines.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind}${op.line}`);
  }
  return lines.join('\n');
}
