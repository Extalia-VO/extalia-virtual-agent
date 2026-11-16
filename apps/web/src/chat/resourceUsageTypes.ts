/** Presentation-only records projected from this conversation's protocol evidence. */
export type ResourceUsageStatus = 'loaded' | 'active' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'unknown';
export interface ResourceUsageAgent {
  id: string;
  label: string;
  role?: 'primary' | 'subagent' | 'unknown';
  parentId?: string;
  teamId?: string;
  status: ResourceUsageStatus;
}
export interface ResourceUsageNode {
  id: string;
  agentId: string;
  kind: 'skill' | 'knowledge';
  label: string;
  status: ResourceUsageStatus;
  count: number;
  lastAt: string;
  detail?: string;
  source?: string;
  evidenceIds: string[];
  /** Exact reported identity only; absent for generic/ambiguous operations. */
  resourceKey?: string;
}
export interface ResourceUsageGraph {
  scopeKey: string;
  agents: ResourceUsageAgent[];
  teams: { id: string; label: string }[];
  nodes: ResourceUsageNode[];
  truncated: boolean;
}
export interface ResourceUsageCopy {
  title: string;
  expand: string;
  more: string;
  accessedBy: string;
  close: string;
  hideDetails: string;
  allAgents: string;
  allTeams: string;
  skills: string;
  knowledge: string;
  empty: string;
  evidence: string;
  owner: string;
  mainAgent: string;
  subagent: string;
  agentDone: string;
  source: string;
  lastActivity: string;
  trace: string;
  limited: string;
  help: string;
  uses(count: number): string;
  nodes(count: number): string;
  statuses: Record<ResourceUsageStatus, string>;
}
