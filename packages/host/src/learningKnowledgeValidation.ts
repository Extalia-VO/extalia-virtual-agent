import type { AnyTool } from '@extalia/runtime';
import type { EventBody } from '@extalia/protocol';
import type { RustLearningInputs, RustLearningJob, RustLearningPort } from './rustLearning.js';

/** Effect adapter only: Rust compares the scoped receipts and decides whether publication is still valid. */
export async function revalidateLearningKnowledge(options: {
  job: RustLearningJob;
  backend: RustLearningPort;
  tools: readonly AnyTool[];
  signal: AbortSignal;
  assertActive(): Promise<void>;
  emit(body: EventBody): Promise<void>;
}): Promise<RustLearningJob> {
  const { job } = options;
  if (!job.knowledgeReads?.length) return job;
  const tool = options.tools.find(item => item.name === 'knowledge_read');
  const reads: RustLearningInputs['job.revalidate']['reads'] = [];
  for (const reference of job.knowledgeReads) {
    await options.assertActive();
    const toolCallId = `${job.jobId}-revalidate-${reads.length + 1}`;
    await options.emit({ type: 'tool.started', toolCallId, tool: 'knowledge_read', kind: 'knowledge', label: 'Confirming the linked note is current' });
    await options.assertActive();
    const input = { path: reference.path, offset: 0, limit: 1 };
    let read = { ok: false, output: 'The linked note could not be revalidated.' };
    try {
      const refusal = tool?.precheck?.(input);
      if (tool && !refusal) {
        const outcome = await tool.run(input, { signal: options.signal, toolCallId, emit: () => undefined });
        read = { ok: outcome.ok, output: outcome.output };
      }
    } catch { /* The Rust job rejects missing/unavailable receipts without exposing adapter diagnostics. */ }
    await options.assertActive();
    reads.push({ path: reference.path, ok: read.ok, output: read.output });
    await options.emit({ type: 'tool.completed', toolCallId, tool: 'knowledge_read', kind: 'knowledge', label: 'Linked note check settled', ok: read.ok, output: 'Source identity returned to the Rust curator.' });
  }
  await options.assertActive();
  return (await options.backend.process('job.revalidate', { jobId: job.jobId, reads })).job;
}
