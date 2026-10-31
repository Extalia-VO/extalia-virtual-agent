import type { ActivityKind } from './events.js';

export * from './events.js';
export * from './validate.js';
export * from './orchestration.js';
export * from './orchestrationValidate.js';
export * from './transitions.js';
export * from './missionJournal.js';
export * from './jsonSchema.js';
export * from './daemon.js';
export * from './workerProtocol.js';
export * from './workerBundle.js';
export * from './daemonExecutions.js';
export * from './daemonPlanning.js';
export * from './daemonSkills.js';
export * from './daemonSkillRouting.js';
export * from './daemonKnowledge.js';
export * from './daemonValidate.js';
export * from './daemonFrame.js';
export * from './protocolSchemas.js';
export * from './control.js';
export * from './controlDelegation.js';
export * from './controlTask.js';
export * from './controlIdentity.js';
export * from './controlValidate.js';

export function classifyTool(name: string): { kind: ActivityKind; label: string } {
  const lower = name.toLowerCase();
  if (/^web|web_?(search|fetch)|browser|fetch_?url|search_web|read_url/.test(lower)) return { kind: 'web', label: `Browsing via ${name}` };
  if (/handback/.test(lower)) return { kind: 'tool', label: `Reporting back via ${name}` };
  if (/^task$|subagent|spawn_?agent/.test(lower)) return { kind: 'delegate', label: `Delegating via ${name}` };
  if (/skill|curat/.test(lower)) return { kind: 'knowledge', label: /manage|write|patch|create|update/.test(lower) ? `Updating skills via ${name}` : `Consulting skills via ${name}` };
  if (/search|grep|find|glob/.test(lower)) return { kind: 'search', label: `Searching via ${name}` };
  if (/read|view|cat/.test(lower)) return { kind: 'read', label: `Reading via ${name}` };
  if (/write|patch|edit|replace/.test(lower)) return { kind: 'edit', label: `Editing via ${name}` };
  if (/terminal|bash|shell|exec|run|command/.test(lower)) return { kind: 'command', label: `Running ${name}` };
  if (/test|check|lint/.test(lower)) return { kind: 'test', label: `Testing via ${name}` };
  if (/delegate|spawn|agent/.test(lower)) return { kind: 'delegate', label: `Delegating via ${name}` };
  return { kind: 'tool', label: `Calling ${name}` };
}


/**
 * v0.0.38: a short display name for an MCP tool (`mcp__<server>__<tool>`, the form
 * Claude Code, Codex and Gemini CLI use), as `server · tool`; undefined for other tools.
 */
export function mcpToolName(name: string): string | undefined {
  const match = /^mcp__([^\s]+?)__([^\s]+)$/.exec(name.trim());
  if (!match) return undefined;
  const clean = (part: string) => part.replace(/[^\w.-]+/g, ' ').trim().slice(0, 40);
  const server = clean(match[1]!), tool = clean(match[2]!);
  return server && tool ? `${server} · ${tool}` : undefined;
}
