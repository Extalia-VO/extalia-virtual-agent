import type { AgentHostApi, SkillRegistryReport } from '@extalia/platform';

// Local React identity only: never a session/authority identifier or persisted data.
const hosts = new WeakMap<AgentHostApi, number>();
let nextHost = 0;
export function skillHostKey(agents: AgentHostApi): number {
  let host = hosts.get(agents);
  if (host === undefined) { host = ++nextHost; hosts.set(agents, host); }
  return host;
}
export function skillPreflightContext(agents: AgentHostApi, report: SkillRegistryReport): string {
  const host = skillHostKey(agents);
  return JSON.stringify([host, report.status, report.preflight, report.indexGeneration, report.scanner, report.inspector, report.revisions]);
}
