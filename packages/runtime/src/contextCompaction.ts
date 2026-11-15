import type { ModelMessage, ModelRequest, ToolResultEntry } from './model.js';
import { checkRequestBudget, type RequestBudgetCheck } from './requestBudget.js';

/** Original messages must be durably readable before a compact projection is admitted. */
export interface ContextCompactionOptions {
  archive(request: { messages: readonly ModelMessage[]; signal: AbortSignal }): Promise<{ reference: string }>;
  /** Local estimated-token trigger, not a claim about a provider's context window. */
  triggerTokens?: number;
  readToolName?: string;
}

export interface ContextCompactionReport {
  count: number;
  archivedResults: number;
  /** The most recent projection change, measured with identical system and tool schemas. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** Sum of local request-estimate reductions; not provider usage or monetary savings. */
  estimatedTokensRemoved: number;
}

interface Replacement { reference: string; messageIndex: number; resultIndex: number; excerpt: number }
type RequestParts = Readonly<Pick<ModelRequest, 'system' | 'tools'>> & { messages: readonly ModelMessage[] };

const DEFAULT_TRIGGER_TOKENS = 24_000;
const MAX_CHANGES = 1024;
const PLACEHOLDER = '0'.repeat(64);
const REFERENCE = /^[a-f0-9]{64}$/;

function edge(value: string, length: number, tail = false): string {
  const part = tail ? value.slice(-length) : value.slice(0, length);
  // Never manufacture a lone surrogate at an excerpt boundary.
  return tail ? part.replace(/^[\uDC00-\uDFFF]/u, '') : part.replace(/[\uD800-\uDBFF]$/u, '');
}

function compactText(result: ToolResultEntry, replacement: Replacement, readTool: string): string {
  const head = edge(result.content, Math.ceil(replacement.excerpt / 2));
  const tail = edge(result.content, Math.floor(replacement.excerpt / 2), true);
  const omitted = result.content.length - head.length - tail.length;
  const input = JSON.stringify({ reference: replacement.reference, messageIndex: replacement.messageIndex,
    resultIndex: replacement.resultIndex, offset: 0, limit: 2000 });
  return `[Archived tool output; status: ${result.isError ? 'error' : 'reported success'}. Original length: ${result.content.length} UTF-16 characters. `
    + `These are exact excerpts, not a summary. Read omitted evidence with ${readTool}(${input}) before relying on it.]\n`
    + `[beginning]\n${head}\n[${omitted} UTF-16 characters omitted]\n[end]\n${tail}`;
}

/**
 * A request-only projection. Original history, user/assistant text, executable arguments,
 * provider replay blocks and tool-call/result identities are never edited or discarded.
 * Only bodies belonging to complete adjacent tool batches may be replaced by excerpts.
 */
export class ContextCompactor {
  private readonly replacements = new Map<ToolResultEntry, Replacement>();
  private readonly trigger: number;
  private readonly readTool: string;
  private reportValue: ContextCompactionReport | undefined;
  private unavailableAt: number | undefined;

  constructor(private readonly options: ContextCompactionOptions) {
    this.trigger = Number.isSafeInteger(options.triggerTokens) && options.triggerTokens! >= 256
      ? Math.min(options.triggerTokens!, 500_000) : DEFAULT_TRIGGER_TOKENS;
    this.readTool = options.readToolName && /^[a-z][a-z0-9_]{0,63}$/.test(options.readToolName)
      ? options.readToolName : 'context_archive_read';
  }

  get report(): ContextCompactionReport | undefined { return this.reportValue ? { ...this.reportValue } : undefined; }

  private projection(messages: readonly ModelMessage[], replacements = this.replacements): ModelMessage[] {
    return messages.map(message => message.role !== 'tool' ? message : {
      ...message, results: message.results.map(result => {
        const replacement = replacements.get(result);
        return replacement ? { ...result, content: compactText(result, replacement, this.readTool) } : result;
      }),
    });
  }

  project(messages: readonly ModelMessage[]): readonly ModelMessage[] {
    return this.replacements.size ? this.projection(messages) : messages;
  }

  wantsCompaction(check: RequestBudgetCheck, maxInputTokens?: number): boolean {
    if (!check.pressure || check.reason === 'invalid-limit' || check.reason === 'unsupported-request') return false;
    const trigger = Math.min(this.trigger, maxInputTokens === undefined ? this.trigger : Math.floor(maxInputTokens * 0.85));
    return Boolean(check.reason) || check.pressure.estimatedTokens > trigger;
  }

  /** False leaves the last acknowledged projection intact; archive failure never drops evidence. */
  async compact(request: RequestParts, maxInputTokens: number | undefined, signal: AbortSignal, force = false): Promise<boolean> {
    signal.throwIfAborted();
    // Never produce a reference the current model cannot resolve through an offered tool.
    if (!request.tools.some(tool => tool.name === this.readTool)) return false;
    const before = checkRequestBudget({ ...request, messages: this.project(request.messages) }, maxInputTokens);
    if (!before.pressure || !force && !this.wantsCompaction(before, maxInputTokens)
      || this.unavailableAt === request.messages.length) return false;
    const candidate = new Map(this.replacements);
    const changed = new Set<ToolResultEntry>();
    const batches: { messageIndex: number; results: ToolResultEntry[] }[] = [];
    for (let index = 1; index < request.messages.length; index++) {
      const message = request.messages[index]!, previous = request.messages[index - 1]!;
      if (message.role !== 'tool' || previous.role !== 'assistant' || !previous.toolCalls.length
        || message.results.length !== previous.toolCalls.length) continue;
      const calls = new Map(previous.toolCalls.map(call => [call.id, call.name]));
      const results = new Set(message.results.map(result => result.toolCallId));
      if (calls.size !== previous.toolCalls.length || results.size !== calls.size
        || message.results.some(result => calls.get(result.toolCallId) !== result.name)) continue;
      batches.push({ messageIndex: index, results: message.results });
    }
    const target = Math.max(1, Math.floor(Math.min(this.trigger, maxInputTokens ?? this.trigger) * 0.7));
    let after = before;
    // Prefer retaining two recent batches in full. Under pressure, smaller excerpts may
    // include recent results too; complete call/result pairs and errors remain explicit.
    for (const [keep, excerpt] of [[2, 1200], [0, 320]] as const) {
      for (const batch of batches.slice(0, Math.max(0, batches.length - keep))) {
        for (let index = 0; index < batch.results.length && changed.size < MAX_CHANGES; index++) {
          const result = batch.results[index]!, current = candidate.get(result);
          if (result.content.length <= excerpt + 800 || current && current.excerpt <= excerpt) continue;
          candidate.set(result, { reference: current?.reference ?? PLACEHOLDER,
            messageIndex: batch.messageIndex, resultIndex: index, excerpt });
          changed.add(result);
        }
        after = checkRequestBudget({ ...request, messages: this.projection(request.messages, candidate) }, maxInputTokens);
        if (after.pressure && after.pressure.estimatedTokens <= target) break;
      }
      if (after.pressure && after.pressure.estimatedTokens <= target) break;
    }
    if (!changed.size || !after.pressure || after.reason || after.pressure.estimatedTokens >= before.pressure.estimatedTokens) return false;
    let reference: string;
    try {
      // Typed images have a separate attachment lifecycle and are never part of saved history.
      const messages = request.messages.map(message => message.role === 'user' && message.images
        ? { role: 'user' as const, text: message.text } : message);
      const receipt = await this.options.archive({ messages, signal });
      signal.throwIfAborted();
      if (!REFERENCE.test(receipt.reference)) throw new Error('Invalid archive receipt.');
      reference = receipt.reference;
    } catch (error) {
      if (signal.aborted) throw error;
      this.unavailableAt = request.messages.length;
      return false;
    }
    for (const result of changed) candidate.get(result)!.reference = reference;
    for (const [result, replacement] of candidate) this.replacements.set(result, replacement);
    const prior = this.reportValue;
    this.reportValue = { count: (prior?.count ?? 0) + 1, archivedResults: this.replacements.size,
      estimatedTokensBefore: before.pressure.estimatedTokens, estimatedTokensAfter: after.pressure.estimatedTokens,
      estimatedTokensRemoved: (prior?.estimatedTokensRemoved ?? 0) + before.pressure.estimatedTokens - after.pressure.estimatedTokens };
    return true;
  }
}
