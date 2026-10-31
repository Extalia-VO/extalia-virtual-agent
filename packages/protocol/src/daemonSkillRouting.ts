import type { SkillPreflightIssue, SkillPreflightPackage } from './daemonSkills.js';

export const SKILL_ROUTING_MAX_BYTES = 512 * 1024;
export const SKILL_ROUTING_INPUT_ISSUES = [
  'empty_selectors', 'selector_limit', 'invalid_category', 'invalid_intent', 'invalid_result_limit', 'candidate_limit', 'context_limit',
  'graph_node_limit', 'graph_edge_limit', 'metadata_limit', 'invalid_claim', 'invalid_context', 'duplicate_candidate_package', 'runtime_fact_limit', 'permission_ceiling_limit',
] as const;
export type SkillRoutingInputIssue = typeof SKILL_ROUTING_INPUT_ISSUES[number];
export interface SkillRoutingInput {
  categories: string[];
  intents: string[];
  candidateRevisionIds: string[];
  pins: Record<string, string>;
  workspaceId?: string;
  maxResults: number;
}
export interface SkillRoutingScore { exactIntents: number; exactCategories: number; descendantCategories: number }
export interface SkillRoutingCandidate {
  identity: SkillPreflightPackage;
  score: SkillRoutingScore;
  matches: { exactIntents: string[]; exactCategories: string[]; descendantCategories: { requested: string; declared: string }[]; rationaleTruncated: boolean };
  /** Dependency-first diagnostics only, never executable dispatch authority. */
  plan: SkillPreflightPackage[];
}
export interface SkillRoutingExclusion {
  identity: SkillPreflightPackage;
  reason: 'selector_mismatch' | 'root_inactive' | 'root_unavailable' | 'inconsistent_preflight';
  diagnostics: SkillPreflightIssue[];
  omittedDiagnostics: number;
}
export interface SkillRoutingReport {
  input: SkillRoutingInput;
  dispatchEligible: false;
  status: 'invalid' | 'no_safe_skill' | 'matched' | 'ambiguous';
  candidates: SkillRoutingCandidate[];
  exclusions: SkillRoutingExclusion[];
  issues: SkillRoutingInputIssue[];
  eligibleCount: number;
  topTieCount: number;
}
