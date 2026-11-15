import { safeText } from '@extalia/core';
import type { ContinuityCoverage, ContinuityEntry } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';

const NATIVE_CONTINUITY_TOOLS = new Set(['continuity_status', 'continuity_read']);
const EXTERNAL_CONTINUITY_TOOLS = new Set(['extalia_continuity_status', 'extalia_continuity_read']);
function isContinuityRead(tool: string): boolean {
  if (NATIVE_CONTINUITY_TOOLS.has(tool) || EXTERNAL_CONTINUITY_TOOLS.has(tool)) return true;
  // Preserve the full identity: mcpToolName is a truncated display label. The
  // supported provider wrapper splits at its first server/tool separator.
  const wrapped = /^mcp__[^\s]+?__([^\s]+)$/.exec(tool);
  return !!wrapped && EXTERNAL_CONTINUITY_TOOLS.has(wrapped[1]!);
}

/** Never replay source tools or recursively quote earlier generated handover capsules. */
export function handoverEvidence(events: readonly ExtaliaEvent[], observed = false): {
  entries: ContinuityEntry[]; coverage: ContinuityCoverage;
} {
  const entries: ContinuityEntry[] = [];
  const seen = new Set<string>();
  let clipped = 0;
  let attachments = 0;
  for (const event of events) {
    if (seen.has(event.id) || event.source.adapter === 'handover-context') continue;
    seen.add(event.id);
    const body = event.body;
    if (body.type === 'tool.completed' && isContinuityRead(body.tool)) continue;
    let kind: ContinuityEntry['kind'], text: string;
    switch (body.type) {
      case 'prompt.submitted':
        kind = 'user'; text = body.text;
        if (body.attachments?.length) {
          attachments += body.attachments.length;
          text += `\n[Source attachments; bytes are not transferred: ${JSON.stringify(body.attachments.map(({ name, kind, size }) => ({ name, kind, size })))}]`;
        }
        break;
      case 'model.completed': kind = 'assistant'; text = body.text; break;
      case 'tool.completed':
        kind = 'tool';
        attachments += body.attachments?.length ?? 0;
        text = JSON.stringify({ tool: body.tool, ok: body.ok, target: body.target, output: body.output,
          ...(body.attachments?.length ? { attachments: body.attachments.map(({ name, kind, size }) => ({ name, kind, size })), attachmentBytesTransferred: false } : {}) });
        break;
      case 'tool.output': kind = 'tool'; text = body.text; break;
      case 'command.output': kind = 'tool'; text = `${body.stream}: ${body.text}`; break;
      case 'file.written': kind = 'file'; text = JSON.stringify(body); break;
      case 'turn.failed': kind = 'status'; text = `Turn failed: ${body.error}`; break;
      case 'meeting.contribution': kind = 'assistant'; text = `Meeting round ${body.round}: ${body.text}`; break;
      case 'meeting.completed': kind = 'status'; text = JSON.stringify(body); break;
      default: continue;
    }
    if (!text.trim()) continue;
    const clean = safeText(text, 32_000);
    if (text.length > 32_000) clipped++;
    entries.push({ id: event.id, kind, text: clean, at: event.at });
  }
  const limits = observed ? ['Only transcript and hook events visible to Extalia are available. Hidden harness context and compacted or unread source history are unknown.'] : [];
  if (clipped) limits.push(`${clipped} long evidence entries were clipped at 32000 characters; inspect the original source for their full contents.`);
  if (attachments) limits.push(`${attachments} source attachments are represented by metadata only. Image and file bytes were not transferred; inspect the source or reattach required files.`);
  if (!entries.length) limits.push('No conversation or tool evidence is visible in this source.');
  return { entries, coverage: {
    mode: observed || clipped || attachments ? 'partial' : entries.length ? 'full' : 'unknown',
    ...(entries.at(-1) ? { observedThrough: entries.at(-1)!.id } : {}),
    observedEntries: entries.length, omittedEntries: 0, limits,
  } };
}
