import type { ActivityKind } from './events.js';

export * from './events.js';
export * from './validate.js';

export function classifyTool(name: string): { kind: ActivityKind; label: string } {
  const lower = name.toLowerCase();
  if (/search|grep|find|glob/.test(lower)) return { kind: 'search', label: `Searching via ${name}` };
  if (/read|view|cat/.test(lower)) return { kind: 'read', label: `Reading via ${name}` };
  if (/write|patch|edit|replace/.test(lower)) return { kind: 'edit', label: `Editing via ${name}` };
  if (/terminal|bash|shell|exec|run|command/.test(lower)) return { kind: 'command', label: `Running ${name}` };
  if (/test|check|lint/.test(lower)) return { kind: 'test', label: `Testing via ${name}` };
  if (/delegate|spawn|agent/.test(lower)) return { kind: 'delegate', label: `Delegating via ${name}` };
  return { kind: 'tool', label: `Calling ${name}` };
}

