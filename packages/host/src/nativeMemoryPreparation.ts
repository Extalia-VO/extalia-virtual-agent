import { createHash } from 'node:crypto';
import { redact } from '@extalia/core';
import { checkRequestBudget, type RequestBudgetCheck, type TurnOptions } from '@extalia/runtime';
import type { NativeKnowledgePort } from './nativeKnowledgeTools.js';
import { collectKnowledgeRecall, planNativeRecallQuery, renderKnowledgeRecall, type KnowledgeRecallNote, type KnowledgeRecallPlan } from './nativeRecallPlan.js';

export { recallKnowledgeContext, workRecallQuery } from './nativeRecallPlan.js';

export type NativeContextSource =
  | { kind: 'work-memory'; id: string; revision: string; coverage: 'preview'; status: 'current' }
  | { kind: 'knowledge'; path: string; revision?: string; coverage: 'preview' | 'reference';
    status: 'current' | 'unavailable' | 'not-read'; relation?: string };

/** Metadata only: no query, prompt, note text, absolute vault root or historical content. */
export interface NativeContextBlockReceipt {
  id: string;
  kind: 'work-memory' | 'knowledge';
  status: 'included' | 'dropped' | 'unavailable' | 'empty';
  reason?: 'optional-budget' | 'request-budget' | 'source-unavailable' | 'no-query' | 'no-match'
    | 'selection-limit' | 'read-budget' | 'knowledge-budget';
  budgetReason?: RequestBudgetCheck['reason'];
  /** True only when this candidate contained freshly retrieved preview text. */
  retrieved: boolean;
  sources: NativeContextSource[];
  sourcesComplete: boolean;
  /** Hash of the exact candidate block, excluding its two-newline separator. */
  contentSha256?: string;
  characters: number;
  includedCharacters: number;
  /** Local request-budget estimates, not provider token usage or cost savings. */
  estimatedTokens: number;
  includedEstimatedTokens: number;
  trust: 'untrusted-evidence';
}

export interface NativeMemoryPreparationReport {
  // Keep the original aggregate fields for existing activity consumers.
  recalled: number;
  knowledge: boolean;
  included: boolean;
  incomplete: boolean;
  characters: number;
  queryBasis: 'current' | 'continuation' | 'none';
  queryContextMessages: number;
  blocks: NativeContextBlockReceipt[];
  /** Distinct source revisions with preview text, excluding unread references. */
  retrievedSourceCount: number;
  includedSourceCount: number;
  droppedSourceCount: number;
  knowledgeScope?: { workspaceId: string; profileId?: string; bindingRevision?: string };
  optionalCharacterLimit: number;
  /** Admitted optional characters including separators; mandatory skills are excluded. */
  optionalCharacters: number;
  requestEstimatedTokens?: number;
  estimateBasis: 'request-character-heuristic';
}

interface Options {
  enabled: boolean;
  inputTokenLimit?: number;
  /** Independently bounded even when the provider has no explicit token ceiling. */
  maxOptionalCharacters?: number;
  assertCurrent(): void | Promise<void>;
  recall(query: string, signal: AbortSignal): Promise<{ text: string; records: readonly unknown[]; incomplete: boolean; omitted: number; available?: boolean }>;
  knowledge?: NativeKnowledgePort;
  prepareSkills?: NonNullable<TurnOptions['prepareRequest']>;
  report?(report: NativeMemoryPreparationReport): void | Promise<void>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const revision = /^[a-f0-9]{64}$/;
const sourceKey = (source: NativeContextSource) => JSON.stringify(source.kind === 'knowledge'
  ? [source.kind, source.path, source.revision] : [source.kind, source.id, source.revision]);

function memorySources(records: readonly unknown[]): NativeContextSource[] {
  const sources: NativeContextSource[] = [];
  for (const record of records.slice(0, 32)) {
    if (!record || typeof record !== 'object') continue;
    const { id, revision: version } = record as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || redact(id) !== id
      || typeof version !== 'string' || !revision.test(version)) continue;
    sources.push({ kind: 'work-memory', id, revision: version, coverage: 'preview', status: 'current' });
  }
  return sources;
}

function knowledgeSources(note: KnowledgeRecallNote): NativeContextSource[] {
  return [{ kind: 'knowledge', path: note.path, revision: note.revision, coverage: 'preview', status: 'current' },
    ...note.updates.map(update => ({ kind: 'knowledge' as const, path: update.path, revision: update.revision,
      coverage: update.status === 'current' ? 'preview' as const : 'reference' as const, status: update.status, relation: update.relation }))];
}

function receipt(kind: NativeContextBlockReceipt['kind'], sources: NativeContextSource[], text: string, scope?: NativeMemoryPreparationReport['knowledgeScope']): NativeContextBlockReceipt {
  return { id: hash(JSON.stringify([kind, scope, sources])), kind, status: text ? 'dropped' : 'empty', retrieved: Boolean(text), sources,
    sourcesComplete: true, ...(text ? { contentSha256: hash(text) } : {}), characters: text.length, includedCharacters: 0,
    estimatedTokens: text ? Math.ceil((text.length + 2) / 4) : 0, includedEstimatedTokens: 0, trust: 'untrusted-evidence' };
}

/** Local retrieval precedes each provider admission, including changed steering and workers. */
export function createNativeMemoryPreparation(options: Options): NonNullable<TurnOptions['prepareRequest']> {
  let lastReport = '';
  const optionalLimit = Number.isSafeInteger(options.maxOptionalCharacters) && options.maxOptionalCharacters! >= 0
    ? Math.min(options.maxOptionalCharacters!, 16_384) : 8_192;
  return async request => {
    const check = async () => { request.signal.throwIfAborted(); await options.assertCurrent(); request.signal.throwIfAborted(); };
    await check();
    // Mandatory skill instructions own their budget before optional historical recall.
    let system = options.prepareSkills ? await options.prepareSkills(request) : request.system;
    await check();
    if (options.enabled) {
      const query = planNativeRecallQuery(request.messages);
      let memory: Awaited<ReturnType<Options['recall']>> = { text: '', records: [], incomplete: false, omitted: 0 };
      let knowledge: KnowledgeRecallPlan | undefined, knowledgeUnavailable = false;
      if (query.query) {
        try { memory = await options.recall(query.query, request.signal); }
        catch { request.signal.throwIfAborted(); memory = { ...memory, incomplete: true, available: false }; }
        // Revocation during memory I/O must stop before any subsequent vault I/O.
        await check();
        if (options.knowledge) try { knowledge = await collectKnowledgeRecall(options.knowledge, query.query, request.signal, check); }
        catch { request.signal.throwIfAborted(); knowledgeUnavailable = true; }
      }
      await check();
      const knowledgeScope = knowledge ? { workspaceId: knowledge.workspaceId, profileId: knowledge.profileId, bindingRevision: knowledge.bindingRevision } : undefined;
      const blocks: NativeContextBlockReceipt[] = [], candidates: { text: string; receipt: NativeContextBlockReceipt }[] = [];
      const memoryReceipt = receipt('work-memory', memorySources(memory.records), memory.text);
      memoryReceipt.sourcesComplete = memoryReceipt.sources.length === memory.records.length;
      if (memory.text) candidates.push({ text: memory.text, receipt: memoryReceipt });
      else {
        memoryReceipt.status = memory.available === false ? 'unavailable' : 'empty';
        memoryReceipt.reason = memory.available === false ? 'source-unavailable' : query.query ? 'no-match' : 'no-query';
      }
      blocks.push(memoryReceipt);
      for (const note of knowledge?.notes ?? []) {
        const text = renderKnowledgeRecall({ ...knowledge!, notes: [note] });
        const item = receipt('knowledge', knowledgeSources(note), text, knowledgeScope);
        item.sourcesComplete = !note.updatesIncomplete;
        blocks.push(item); candidates.push({ text, receipt: item });
      }
      for (const omitted of knowledge?.omissions ?? []) {
        const text = omitted.preview ? renderKnowledgeRecall({ ...knowledge!, notes: [omitted.preview] }) : '';
        const sources: NativeContextSource[] = omitted.preview ? knowledgeSources(omitted.preview)
          : [{ kind: 'knowledge', path: omitted.path, revision: omitted.revision, coverage: 'reference',
            status: omitted.reason === 'source-unavailable' ? 'unavailable' : 'not-read' }];
        const item = receipt('knowledge', sources, text, knowledgeScope);
        item.sourcesComplete = !omitted.preview?.updatesIncomplete;
        item.status = omitted.reason === 'source-unavailable' ? 'unavailable' : 'dropped'; item.reason = omitted.reason;
        blocks.push(item);
      }
      if (options.knowledge && !knowledge?.notes.length && !knowledge?.omissions.length) {
        const item = receipt('knowledge', [], '', knowledgeScope);
        item.status = knowledgeUnavailable ? 'unavailable' : 'empty';
        item.reason = knowledgeUnavailable ? 'source-unavailable' : query.query ? 'no-match' : 'no-query'; blocks.push(item);
      }
      let optionalCharacters = 0, characters = 0;
      let pressure = checkRequestBudget({ system, messages: request.messages, tools: request.tools }, options.inputTokenLimit).pressure;
      for (const candidate of candidates) {
        const item = candidate.receipt, next = `${system}\n\n${candidate.text}`;
        const budget = checkRequestBudget({ system: next, messages: request.messages, tools: request.tools }, options.inputTokenLimit);
        if (budget.pressure && pressure) item.estimatedTokens = budget.pressure.estimatedTokens - pressure.estimatedTokens;
        if (optionalCharacters + candidate.text.length + 2 > optionalLimit) item.reason = 'optional-budget';
        else if (budget.reason) { item.reason = 'request-budget'; item.budgetReason = budget.reason; }
        else {
          system = next; characters += candidate.text.length; optionalCharacters += candidate.text.length + 2; pressure = budget.pressure;
          item.status = 'included'; item.includedCharacters = candidate.text.length; item.includedEstimatedTokens = item.estimatedTokens;
        }
      }
      const retrievedSources = new Set(blocks.filter(block => block.retrieved).flatMap(block => block.sources.filter(source => source.coverage === 'preview').map(sourceKey)));
      const includedSources = new Set(blocks.filter(block => block.status === 'included').flatMap(block => block.sources.filter(source => source.coverage === 'preview').map(sourceKey)));
      const report: NativeMemoryPreparationReport = {
        recalled: memory.records.length, knowledge: Boolean(knowledge?.notes.length), included: optionalCharacters > 0,
        incomplete: memory.incomplete || memory.omitted > 0 || knowledgeUnavailable || Boolean(knowledge?.incomplete)
          || blocks.some(block => block.status === 'dropped' || block.status === 'unavailable' || !block.sourcesComplete),
        characters, queryBasis: query.basis, queryContextMessages: query.contextMessages, blocks,
        retrievedSourceCount: retrievedSources.size, includedSourceCount: includedSources.size,
        droppedSourceCount: [...retrievedSources].filter(source => !includedSources.has(source)).length,
        ...(knowledgeScope ? { knowledgeScope } : {}), optionalCharacterLimit: optionalLimit, optionalCharacters,
        requestEstimatedTokens: pressure?.estimatedTokens, estimateBasis: 'request-character-heuristic',
      };
      const signature = JSON.stringify(report);
      if (signature !== lastReport) { await options.report?.(report); await check(); lastReport = signature; }
    }
    await check();
    return system;
  };
}
