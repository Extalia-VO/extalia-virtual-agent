import {
  SKILL_APPROVAL_TTL_MS, type BuiltinSkillInfo, normalizeSkillApproval, normalizeSkillApprovalId, normalizeSkillImportSource, normalizeSkillPackageId, normalizeSkillReview,
  normalizeSkillRevisionId, type AgentHostApi, type SkillActionResult, type SkillApprovalRecord, type SkillRegistryReport, type SkillRevisionDetails,
  type SkillRevisionState, type SkillRevisionSummary, type SkillStateEvent,
  normalizeSkillPreflight,
} from '@extalia/platform';

/**
 * The mock host's Skill Security Center (W3): an in-memory registry with sample revisions in the states the UI must
 * show. `skills=legacy` behaves like a host without the native core (W0 panels), `skills=offline` like a native core
 * that is unavailable, and `skills=review` like a daemon that already serves `skill.review` (migration 0004).
 * Like the real daemon, nothing is approved while the scanner is unpinned unless a sample says otherwise.
 */
export type MockSkillMode = 'registry' | 'legacy' | 'offline' | 'review';
type Methods = 'skillRegistry' | 'preflightSkill' | 'inspectSkill' | 'importSkill' | 'reviewSkill' | 'approveSkill' | 'activateSkill' | 'deactivateSkill' | 'rollbackSkill' | 'revokeSkill';

/** A stable, SHA-256-shaped hex string for sample data (not a real digest). */
function hex(seed: string): string {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  while (out.length < 64) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += state.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

interface MockRevision extends SkillRevisionSummary { manifest: string; files: { path: string; size: number }[]; history: SkillStateEvent[]; approvals: SkillApprovalRecord[] }

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
/** A host-format workspace id (`w_…`) for sample W0 consent. */
const MOCK_CONSENT_WORKSPACE = 'w_mh3p2k1x9f04c2a7';

function revision(packageId: string, version: string, origin: SkillRevisionSummary['origin'], state: SkillRevisionState, options: {
  reason?: string; risk?: SkillRevisionSummary['riskClass']; permissions?: SkillRevisionSummary['permissions']; inferred?: boolean; age: number; active?: boolean;
  files?: { path: string; size: number }[];
}): MockRevision {
  const tree = hex(`${packageId}@${version}`);
  const files = options.files ?? [{ path: 'SKILL.md', size: 1840 }];
  const manifest = options.inferred
    ? JSON.stringify({ schema: 'extalia.skill-manifest.v1', id: packageId, version, risk_class: 'declarative' })
    : JSON.stringify({ schema: 'extalia.skill-manifest.v1', id: packageId, version, risk_class: options.risk ?? 'declarative', permissions: options.permissions ?? [] });
  return {
    packageId, revisionId: `skr_${tree}`, origin, version, treeSha256: tree, skillMdSha256: hex(`${packageId}@${version}/SKILL.md`),
    state, ...(options.reason ? { stateReason: options.reason } : {}), riskClass: options.risk ?? 'declarative', manifestInferred: Boolean(options.inferred),
    permissionDigest: hex(`${packageId}@${version}#permissions`), permissions: options.permissions ?? [], active: Boolean(options.active),
    createdAt: at(options.age), updatedAt: at(Math.max(0, options.age - 5)), manifest, files,
    history: [
      { seq: 1, toState: 'discovered', reason: 'imported', at: at(options.age) },
      { seq: 2, fromState: 'discovered', toState: 'quarantined', reason: 'awaiting-inspection', at: at(options.age) },
      ...(state !== 'quarantined' ? [{ seq: 3, fromState: 'quarantined' as const, toState: state, ...(options.reason ? { reason: options.reason } : {}), at: at(Math.max(0, options.age - 5)) }] : []),
    ],
    approvals: [],
  };
}

function samples(): MockRevision[] {
  return [
    revision('release-notes', '0.0.0+tree.3f9a1c0d2b7e4a51', 'imported', 'quarantined', { reason: 'scanner-unavailable', inferred: true, age: 12 }),
    revision('deploy', '1.0.0', 'workspace', 'quarantined', {
      reason: 'scanner-unavailable', risk: 'tool_using', age: 40,
      permissions: [{ capability: 'terminal', scope: 'true' }, { capability: 'filesystem_read', scope: 'scripts/**' }],
      files: [{ path: 'SKILL.md', size: 2210 }, { path: 'extalia-skill.json', size: 410 }],
    }),
    revision('pdf-tools', '2.1.0', 'imported', 'review_required', {
      reason: 'finding-medium', risk: 'executable', age: 300,
      permissions: [{ capability: 'filesystem_read', scope: 'docs/**' }, { capability: 'network', scope: 'api.example.com' }],
      files: [{ path: 'SKILL.md', size: 3120 }, { path: 'extalia-skill.json', size: 520 }, { path: 'scripts/extract.py', size: 6400 }],
    }),
    revision('web-scraper', '0.4.0', 'imported', 'blocked', { reason: 'finding-high', risk: 'executable', age: 900, permissions: [{ capability: 'network', scope: '*' }] }),
    revision('changelog', '1.3.0', 'user', 'awaiting_approval', { reason: 'risk_class', risk: 'tool_using', age: 60, permissions: [{ capability: 'filesystem_write', scope: 'CHANGELOG.md' }] }),
    revision('code-review', '1.2.0', 'user', 'active', { age: 1440, active: true, permissions: [{ capability: 'filesystem_read', scope: 'src/**' }] }),
    revision('code-review', '1.1.0', 'user', 'superseded', { reason: 'superseded', age: 4320, permissions: [{ capability: 'filesystem_read', scope: 'src/**' }] }),
    revision('lint-fixer', '0.9.0', 'workspace', 'revoked', { reason: 'integrity', age: 2880, risk: 'tool_using', permissions: [{ capability: 'terminal', scope: 'true' }] }),
  ];
}

export function createMockSkillRegistry(mode: MockSkillMode, latency: () => Promise<void>): Pick<AgentHostApi, Methods> {
  const revisions = samples();
  let approvalSeq = 0, indexGeneration = 3;
  const find = (revisionId: unknown) => {
    const id = normalizeSkillRevisionId(revisionId);
    const found = revisions.find(item => item.revisionId === id);
    if (!found) throw new Error('That skill revision no longer exists. (not_found)');
    return found;
  };
  const move = (item: MockRevision, to: SkillRevisionState, reason?: string) => {
    item.history.push({ seq: item.history.length + 1, fromState: item.state, toState: to, ...(reason ? { reason } : {}), at: new Date().toISOString() });
    item.state = to;
    if (reason) item.stateReason = reason; else delete item.stateReason;
    item.updatedAt = new Date().toISOString();
  };
  const summary = ({ manifest: _m, files: _f, history: _h, approvals: _a, ...rest }: MockRevision): SkillRevisionSummary => ({ ...rest, permissions: rest.permissions.map(item => ({ ...item })) });
  const report = (): SkillRegistryReport => {
    const base = { review: mode === 'review', preflight: mode !== 'legacy' && mode !== 'offline', approvalTtlMs: SKILL_APPROVAL_TTL_MS, truncated: false };
    if (mode === 'legacy') return { mode: 'legacy', status: 'off', scanner: 'unpinned', ...base, review: false, revisions: [] };
    if (mode === 'offline') return { mode: 'registry', status: 'unavailable', unavailableReason: 'binary_missing', scanner: 'unpinned', ...base, review: false, revisions: [] };
    const sorted = [...revisions].sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : a.revisionId < b.revisionId ? -1 : 1));
    // As the binary today: the fail-closed inspector, so nothing can be inspected (`skill.scanner`).
    const inspector = { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' as const };
    return { mode: 'registry', status: 'ready', scanner: 'unpinned', inspector, ...base, revisions: sorted.map(summary), indexGeneration };
  };
  const ready = async () => {
    await latency();
    if (mode === 'legacy' || mode === 'offline') throw new Error(`The native core is unavailable (${mode === 'legacy' ? 'not-served' : 'binary_missing'}), so nothing changed.`);
  };
  const done = (result: Omit<SkillActionResult, 'report'>): SkillActionResult => ({ ...result, report: report() });
  const activeOf = (packageId: string) => revisions.find(item => item.packageId === packageId && item.active);

  return {
    preflightSkill: async value => {
      await latency();
      if (mode === 'legacy' || mode === 'offline') throw new Error('Dependency checks unavailable.');
      const input = normalizeSkillPreflight(value);
      const root = find(input.rootRevisionId);
      // Presentation fixture only, never a simulated scanner/activation pass.
      return { rootRevisionId: root.revisionId, dispatchEligible: false, status: 'blocked', truncated: false,
        issues: [{ code: 'root_unavailable', packageId: root.packageId }] };
    },
    async skillRegistry() { await latency(); return report(); },
    async inspectSkill(revisionId): Promise<SkillRevisionDetails> {
      await ready();
      const item = find(revisionId);
      return {
        revision: summary(item), manifest: item.manifest,
        files: item.files.map(file => ({ ...file, sha256: hex(`${item.revisionId}/${file.path}`), executable: file.path.endsWith('.py') })),
        inspections: [{ inspectionId: 1, scannerId: 'unavailable', policyVersion: 'extalia.skill-policy.v1', outcome: 'scanner-unavailable', coverage: 'none', startedAt: item.createdAt, finishedAt: item.createdAt }],
        approvals: item.approvals.map(approval => ({ ...approval })), history: item.history.map(event => ({ ...event })),
        // A project skill the user allowed under W0: stored review input, never an approval.
        consent: item.origin === 'workspace' && item.state !== 'revoked'
          ? [{ path: 'SKILL.md', sha256: item.skillMdSha256, allowedAt: at(2 * 1440), workspaceId: MOCK_CONSENT_WORKSPACE }] : [],
      };
    },
    async importSkill(raw) {
      await ready();
      const source = normalizeSkillImportSource(raw);
      const packageId = source.kind === 'workspace' ? source.name : (source.path.split(/[\\/]/).filter(Boolean).pop() ?? 'skill').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
      normalizeSkillPackageId(packageId);
      const version = `0.0.0+tree.${hex(`${packageId}:import`).slice(0, 16)}`;
      const existing = revisions.find(item => item.packageId === packageId && item.version === version);
      if (existing) return done({ revisionId: existing.revisionId, packageId, state: existing.state, created: false, ...(existing.stateReason ? { stateReason: existing.stateReason } : {}) });
      const item = revision(packageId, version, source.kind === 'workspace' ? 'workspace' : 'imported', 'quarantined', { reason: 'scanner-unavailable', inferred: true, age: 0 });
      revisions.push(item);
      return done({ revisionId: item.revisionId, packageId, state: item.state, stateReason: 'scanner-unavailable', created: true });
    },
    async reviewSkill(raw) {
      await ready();
      const input = normalizeSkillReview(raw);
      if (mode !== 'review') throw new Error('Recording a review is not available yet in this version of the native core. (unknown_op: review_unavailable)');
      const item = find(input.revisionId);
      if (item.treeSha256 !== input.treeSha256) throw new Error('The skill changed after it was shown. (conflict: digest_mismatch)');
      if (item.state !== 'review_required') throw new Error('The skill is not in a state that allows this. (conflict: wrong_state)');
      // As the daemon: accept → validated, reject → back to quarantine (only a new inspection leads on).
      move(item, input.decision === 'accept' ? 'validated' : 'quarantined', input.decision === 'accept' ? 'review-accepted' : 'review-rejected');
      return done({ revisionId: item.revisionId, packageId: item.packageId, state: item.state });
    },
    async approveSkill(raw) {
      await ready();
      const input = normalizeSkillApproval(raw);
      const item = find(input.revisionId);
      if (item.state !== 'awaiting_approval' && item.state !== 'auto_eligible') throw new Error('The skill is not in a state that allows this. Reload the list and check its state. (conflict: wrong_state)');
      if (item.treeSha256 !== input.treeSha256) throw new Error('The skill changed after it was shown. (conflict: digest_mismatch)');
      if (item.permissionDigest !== input.permissionDigest) throw new Error('The declared permissions changed after they were shown. (conflict: permission_digest_mismatch)');
      const expiresAt = new Date(Date.now() + SKILL_APPROVAL_TTL_MS).toISOString();
      const approval: SkillApprovalRecord = { approvalId: ++approvalSeq, kind: 'user', approver: 'user:local', status: 'granted', permissionDigest: item.permissionDigest, createdAt: new Date().toISOString(), expiresAt };
      item.approvals.push(approval);
      move(item, 'approved');
      return done({ revisionId: item.revisionId, packageId: item.packageId, state: item.state, approvalId: approval.approvalId, expiresAt });
    },
    async activateSkill(revisionId, approvalId) {
      await ready();
      const item = find(revisionId);
      if (approvalId !== undefined) normalizeSkillApprovalId(approvalId);
      if (item.state !== 'approved') throw new Error('The skill is not in a state that allows this. (conflict: wrong_state)');
      const approval = item.approvals.filter(entry => entry.status === 'granted').at(-1);
      if (!approval) throw new Error('Approve this revision before activating it.');
      const previous = activeOf(item.packageId);
      if (previous) { previous.active = false; move(previous, 'superseded', 'superseded'); }
      item.active = true;
      move(item, 'active');
      indexGeneration++;
      return done({ revisionId: item.revisionId, packageId: item.packageId, state: 'active', approvalId: approval.approvalId });
    },
    async deactivateSkill(raw) {
      await ready();
      const item = activeOf(normalizeSkillPackageId(raw));
      if (!item) throw new Error('This skill is not active. (not_found)');
      item.active = false;
      move(item, 'approved', 'user-request');
      indexGeneration++;
      return done({ revisionId: item.revisionId, packageId: item.packageId, state: item.state });
    },
    async rollbackSkill(rawPackage, rawRevision) {
      await ready();
      const packageId = normalizeSkillPackageId(rawPackage);
      const item = find(rawRevision);
      if (item.packageId !== packageId || item.state !== 'superseded') throw new Error('Rollback can only return to a revision that was active before. (denied: not_previously_active)');
      const previous = activeOf(packageId);
      if (previous) { previous.active = false; move(previous, 'superseded', 'superseded'); }
      item.active = true;
      move(item, 'active', 'rollback');
      indexGeneration++;
      return done({ revisionId: item.revisionId, packageId, state: 'active' });
    },
    async revokeSkill(revisionId) {
      await ready();
      const item = find(revisionId);
      if (item.state === 'revoked') throw new Error('The skill is not in a state that allows this. (conflict: wrong_state)');
      item.active = false;
      for (const approval of item.approvals) if (approval.status === 'granted') { approval.status = 'revoked'; approval.revokedAt = new Date().toISOString(); }
      move(item, 'revoked', 'user-revoked');
      indexGeneration++;
      return done({ revisionId: item.revisionId, packageId: item.packageId, state: item.state });
    },
  };
}

/** Sample built-in skills (the host lists the ones in `packages/host/src/builtinSkills.ts`); read-only in every mode. */
export const MOCK_BUILTIN_SKILLS: readonly BuiltinSkillInfo[] = [
  { name: 'code-review', category: 'quality', description: 'Review the current changes for correctness bugs first, then clarity; report findings with file:line.', body: '# Code review\n\nInspect the sample changes and report findings with file references.' },
  { name: 'commit-changes', category: 'delivery', description: 'Review the working tree, run the checks, and commit with a clear Conventional Commit message.', body: '# Commit changes\n\nReview the sample working tree, verify the changes and prepare a clear commit message.' },
  { name: 'debug-issue', category: 'development', description: 'Reproduce a bug, find the root cause, fix it and add a regression test.', body: '# Debug an issue\n\nReproduce the sample issue, investigate its cause and verify a focused fix.' },
  { name: 'explain-codebase', category: 'documentation', description: 'Map the structure, entry points and data flow of a codebase; cite files.', body: '# Explain a codebase\n\nDescribe the sample project structure, entry points and data flow with file references.' },
  { name: 'plan-feature', category: 'planning', description: 'Turn a feature request into a short plan, research it, then build and verify it step by step.', body: '# Plan and build a feature\n\nClarify the sample goal, research the affected code and plan small verified steps.' },
  { name: 'refactor-safely', category: 'development', description: 'Restructure code without changing behavior, in small verified steps.', body: '# Refactor safely\n\nCheck the sample behavior, make a small structural change and verify it.' },
  { name: 'security-review', category: 'security', description: 'Check code for common security problems and report them by severity with concrete fixes.', body: '# Security review\n\nTrace sample inputs across trust boundaries and report security findings with concrete fixes.' },
  { name: 'update-docs', category: 'documentation', description: 'Bring README and docs in line with the current code; keep them short and accurate.', body: '# Update documentation\n\nCompare the sample documentation with current behavior and update the relevant examples.' },
  { name: 'write-tests', category: 'quality', description: 'Add focused tests next to the existing ones, run them, and fix failures.', body: '# Write tests\n\nFollow the sample project conventions and cover the changed behavior and its edge cases.' },
];

export function createMockBuiltinSkills(latency: () => Promise<void>): Required<Pick<AgentHostApi, 'builtinSkills'>> {
  return {
    async builtinSkills() {
      await latency();
      return MOCK_BUILTIN_SKILLS.map(skill => ({ ...skill }));
    },
  };
}
