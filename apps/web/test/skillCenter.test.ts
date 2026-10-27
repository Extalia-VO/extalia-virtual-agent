import type { AgentHostApi, SkillActionResult, SkillRegistryReport, SkillRevisionDetails, SkillRevisionSummary, SkillScannerReport } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import {
  SkillApproveConfirm, SkillDetails, SkillScannerBanner, SkillSecurityCenter, SkillSecurityCenterView, type SkillConfirm,
} from '../src/skills/SkillSecurityCenter';
import {
  applySkillCenterAction, approvalFor, groupSkillPackages, revisionActions, shortDigest, skillCenterSupported, skillRegistryMode, type SkillCenterAction,
} from '../src/skills/skillCenterModel';

const t = MESSAGES.en;
const hex = (digit: string) => digit.repeat(64);

function revision(packageId: string, state: SkillRevisionSummary['state'], overrides: Partial<SkillRevisionSummary> = {}): SkillRevisionSummary {
  const tree = overrides.treeSha256 ?? hex(String(packageId.length % 10));
  return {
    packageId, revisionId: `skr_${tree}`, origin: 'imported', version: '1.0.0', treeSha256: tree, skillMdSha256: hex('e'), state, riskClass: 'declarative',
    manifestInferred: false, permissionDigest: hex('d'), permissions: [], active: false, createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:00.000Z',
    ...overrides,
  };
}

const QUARANTINED = revision('release-notes', 'quarantined', { stateReason: 'scanner-unavailable', treeSha256: '0123456789ab' + 'f'.repeat(52), manifestInferred: true });
const AWAITING = revision('changelog', 'awaiting_approval', {
  stateReason: 'risk_class', riskClass: 'tool_using', treeSha256: hex('a'), permissionDigest: hex('c'),
  permissions: [{ capability: 'filesystem_write', scope: 'CHANGELOG.md' }, { capability: 'terminal', scope: 'true' }],
});
const ACTIVE = revision('code-review', 'active', { active: true, treeSha256: hex('1'), createdAt: '2026-10-23T09:00:00.000Z' });
const SUPERSEDED = revision('code-review', 'superseded', { stateReason: 'superseded', treeSha256: hex('2'), version: '0.9.0', createdAt: '2026-10-22T09:00:00.000Z' });
const BLOCKED = revision('web-scraper', 'blocked', { stateReason: 'finding-high', treeSha256: hex('3') });
const REVIEW = revision('pdf-tools', 'review_required', { stateReason: 'finding-medium', treeSha256: hex('4') });

const REPORT: SkillRegistryReport = {
  mode: 'registry', status: 'ready', scanner: 'unpinned', review: false, approvalTtlMs: 600_000, truncated: false, indexGeneration: 2,
  revisions: [QUARANTINED, AWAITING, ACTIVE, SUPERSEDED, BLOCKED, REVIEW],
};

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(item => item.type === 'button' && (item.props['aria-label'] === label || text(item.props.children as ReactNode) === label));
  if (!found) throw new Error(`No button "${label}"`);
  return found.props as { onClick: () => void; disabled?: boolean };
}

function view(overrides: Partial<Parameters<typeof SkillSecurityCenterView>[0]> = {}) {
  return SkillSecurityCenterView({
    t, report: REPORT, busy: false, error: null, notice: null, confirm: null, importer: null, details: {},
    onRetry: () => undefined, onConfirm: () => undefined, onImporter: () => undefined, onAction: () => undefined, onToggleDetails: () => undefined, ...overrides,
  });
}
const html = (overrides: Partial<Parameters<typeof SkillSecurityCenterView>[0]> = {}) => renderToStaticMarkup(view(overrides));

function fakeHost(report: SkillRegistryReport = REPORT) {
  const result = (extra: Partial<SkillActionResult> = {}): SkillActionResult => ({ report, ...extra });
  return {
    skillRegistry: vi.fn(async () => report),
    inspectSkill: vi.fn(),
    importSkill: vi.fn(async () => result({ state: 'quarantined' })),
    reviewSkill: vi.fn(async () => result()),
    approveSkill: vi.fn(async () => result({ state: 'approved', approvalId: 1 })),
    activateSkill: vi.fn(async () => result({ state: 'active' })),
    deactivateSkill: vi.fn(async () => result()),
    rollbackSkill: vi.fn(async () => result()),
    revokeSkill: vi.fn(async () => result()),
  };
}

describe('Skill Security Center', () => {
  it('lists packages with state chips, plain-language reasons, permissions and short hashes with the full hash as tooltip', () => {
    const markup = html();
    expect(markup).toContain('Skill Security Center');
    expect(markup).toContain('Imported skills stay quarantined until a verified scanner is configured.');
    expect(markup).toContain('Skills (5)');
    expect(markup).toContain('>Quarantined<');
    expect(markup).toContain('Scanner unavailable: no verified scanner is configured');
    expect(markup).toContain('Blocked: high-severity finding');
    expect(markup).toContain('Review required: medium-severity finding');
    expect(markup).toContain('Needs your approval: uses tools or ships code');
    expect(markup).toContain('Write files<code>CHANGELOG.md</code>');
    expect(markup).toContain('>Terminal<');
    expect(markup).toContain('No permissions declared');
    expect(markup).toContain(`title="Package SHA-256 ${QUARANTINED.treeSha256}">0123456789ab</code>`);
    expect(markup).toContain(`title="Permission digest ${hex('c')}">cccccccccccc</code>`);
    expect(markup).not.toContain(`>${QUARANTINED.treeSha256}<`);
    expect(markup).toContain('Active: v1.0.0');
    expect(markup).toContain('No extalia-skill.json: inferred manifest');
    expect(shortDigest(hex('a'))).toBe('aaaaaaaaaaaa');
    // An unknown reason code is shown as the code, never dropped.
    expect(html({ report: { ...REPORT, revisions: [revision('x', 'quarantined', { stateReason: 'new_reason' })] } })).toContain('Reason: new_reason');
  });

  it('offers the actions each lifecycle state allows', () => {
    expect(revisionActions(QUARANTINED)).toEqual(['revoke']);
    expect(revisionActions(REVIEW)).toEqual(['review', 'revoke']);
    expect(revisionActions(AWAITING)).toEqual(['approve', 'revoke']);
    expect(revisionActions(revision('a', 'approved'))).toEqual(['activate', 'revoke']);
    expect(revisionActions(ACTIVE)).toEqual(['deactivate', 'revoke']);
    expect(revisionActions(SUPERSEDED)).toEqual(['rollback', 'revoke']);
    expect(revisionActions(BLOCKED)).toEqual([]);
    expect(revisionActions(revision('a', 'revoked'))).toEqual([]);
    const tree = view();
    expect(() => button(tree, 'Approve… changelog v1.0.0')).not.toThrow();
    expect(() => button(tree, 'Approve… release-notes v1.0.0')).toThrow();
    expect(() => button(tree, 'Activate release-notes v1.0.0')).toThrow();
    expect(() => button(tree, 'Roll back to this code-review v0.9.0')).not.toThrow();
    expect(() => button(tree, 'Deactivate code-review v1.0.0')).not.toThrow();
    const groups = groupSkillPackages(REPORT.revisions);
    expect(groups.find(group => group.packageId === 'code-review')).toMatchObject({ active: { revisionId: ACTIVE.revisionId }, revisions: [{ version: '1.0.0' }, { version: '0.9.0' }] });
  });

  it('shows exactly the digests being approved and the 10-minute expiry, and sends only those digests', async () => {
    const confirm: SkillConfirm = { kind: 'approve', revisionId: AWAITING.revisionId };
    const markup = html({ confirm });
    expect(markup).toContain('Approve changelog v1.0.0');
    expect(markup).toContain(`<code>${hex('a')}</code>`);
    expect(markup).toContain(`<code>${hex('c')}</code>`);
    expect(markup).toContain('The approval expires in 10 minutes unless you activate the revision.');

    const host = fakeHost();
    const actions: SkillCenterAction[] = [];
    const tree = view({ confirm, onAction: action => { actions.push(action); void applySkillCenterAction(host, action); } });
    button(tree, 'Approve these digests').onClick();
    expect(actions).toEqual([{ kind: 'approve', input: { revisionId: AWAITING.revisionId, treeSha256: hex('a'), permissionDigest: hex('c') } }]);
    expect(host.approveSkill).toHaveBeenCalledWith({ revisionId: AWAITING.revisionId, treeSha256: hex('a'), permissionDigest: hex('c') });
    expect(approvalFor({ ...AWAITING, permissions: [{ capability: 'secrets', scope: 'x' }] } as SkillRevisionSummary)).toEqual({ revisionId: AWAITING.revisionId, treeSha256: hex('a'), permissionDigest: hex('c') });

    const pending = SkillApproveConfirm({ t, revision: AWAITING, ttlMs: 600_000, busy: true, onApprove: () => undefined, onCancel: () => undefined });
    expect(button(pending, 'Approve these digests').disabled).toBe(true);
  });

  it('asks before revoking and explains when reviews are not available yet', () => {
    const revoke = html({ confirm: { kind: 'revoke', revisionId: QUARANTINED.revisionId } });
    expect(revoke).toContain('A revoked revision can never be approved or activated again.');
    const review = html({ confirm: { kind: 'review', revisionId: REVIEW.revisionId } });
    expect(review).toContain('Recording a review is not available yet in this version of the native core.');
    expect(review).toMatch(/<textarea[^>]*disabled/);
    const served = html({ report: { ...REPORT, review: true }, confirm: { kind: 'review', revisionId: REVIEW.revisionId } });
    expect(served).toContain('Accept records your review');
    expect(served).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('shows the unavailable daemon instead of the list, and an error with a reloaded report', async () => {
    const offline: SkillRegistryReport = { ...REPORT, status: 'unavailable', unavailableReason: 'locked', revisions: [] };
    const markup = html({ report: offline });
    expect(markup).toContain('The native core is unavailable (locked).');
    expect(markup).toContain('built-in skills still are');
    expect(markup).not.toContain('Import from folder');
    expect(html({ report: { ...offline, unavailableReason: 'not-served' } })).toContain('does not serve the skill registry');
    expect(html({ report: { ...REPORT, scanner: 'pinned' } })).not.toContain('stay quarantined until');

    const host = fakeHost();
    host.approveSkill.mockRejectedValueOnce(new Error('The approval expired before activation. (denied: approval_expired)'));
    const failed = await applySkillCenterAction(host, { kind: 'approve', input: approvalFor(AWAITING) });
    expect(failed.error).toContain('approval_expired');
    expect(failed.report).toBe(REPORT);
  });

  it('renders in Indonesian', () => {
    const markup = renderToStaticMarkup(SkillSecurityCenterView({
      t: MESSAGES.id, report: REPORT, busy: false, error: null, notice: null, confirm: { kind: 'approve', revisionId: AWAITING.revisionId }, importer: null, details: {},
      onRetry: () => undefined, onConfirm: () => undefined, onImporter: () => undefined, onAction: () => undefined, onToggleDetails: () => undefined,
    }));
    expect(markup).toContain('Pusat Keamanan Skill');
    expect(markup).toContain('Skill yang diimpor tetap dikarantina sampai scanner terverifikasi dikonfigurasi.');
    expect(markup).toContain('Dikarantina');
    expect(markup).toContain('Persetujuan kedaluwarsa dalam 10 menit');
    expect(markup).toContain('Impor dari folder');
  });

  it('is hidden when the host lacks the methods or runs without the native core', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(skillCenterSupported(agents)).toBe(true);
    expect(await skillRegistryMode(agents)).toBe('registry');
    const { skillRegistry: _a, inspectSkill: _b, importSkill: _c, ...older } = agents;
    const legacyHost = older as unknown as AgentHostApi;
    expect(skillCenterSupported(legacyHost)).toBe(false);
    expect(await skillRegistryMode(legacyHost)).toBe('legacy');
    const state = await agents.getState();
    expect(renderToStaticMarkup(createElement(SkillSecurityCenter, { t, agents: legacyHost, state }))).toBe('');
    const flagOff = createMockPlatform({ seed: 'ready', host: 'bridge', skills: 'legacy' }).capabilities.agents!;
    expect(await skillRegistryMode(flagOff)).toBe('legacy');
    expect(await flagOff.skillRegistry()).toMatchObject({ mode: 'legacy', status: 'off' });
    const refusing = { ...agents, skillRegistry: () => Promise.reject(new Error('Unknown method.')) } as AgentHostApi;
    expect(await skillRegistryMode(refusing)).toBe('legacy');
  });

  it('walks the lifecycle through the mock host', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const report = await agents.skillRegistry();
    expect(report).toMatchObject({ mode: 'registry', status: 'ready', scanner: 'unpinned', review: false, inspector: { scannerId: 'unavailable', status: 'unavailable' } });
    const project = report.revisions.find(item => item.origin === 'workspace' && item.state === 'quarantined')!;
    expect((await agents.inspectSkill(project.revisionId)).consent).toMatchObject([{ path: 'SKILL.md', sha256: project.skillMdSha256, workspaceId: 'w_mh3p2k1x9f04c2a7' }]);
    const states = new Set(report.revisions.map(item => item.state));
    for (const state of ['quarantined', 'review_required', 'blocked', 'awaiting_approval', 'active', 'superseded', 'revoked'] as const) expect(states).toContain(state);

    const workspaceId = (await agents.getState()).workspaces[0]!.id;
    const imported = await applySkillCenterAction(agents, { kind: 'import', source: { kind: 'workspace', workspaceId, name: 'deploy-docs' } });
    expect(imported.result).toMatchObject({ state: 'quarantined', stateReason: 'scanner-unavailable', created: true });
    const quarantined = imported.report!.revisions.find(item => item.revisionId === imported.result!.revisionId)!;
    const refused = await applySkillCenterAction(agents, { kind: 'approve', input: approvalFor(quarantined) });
    expect(refused.error).toContain('wrong_state');

    const awaiting = report.revisions.find(item => item.state === 'awaiting_approval')!;
    const stale = await applySkillCenterAction(agents, { kind: 'approve', input: { ...approvalFor(awaiting), permissionDigest: 'f'.repeat(64) } });
    expect(stale.error).toContain('permission_digest_mismatch');
    const approved = await applySkillCenterAction(agents, { kind: 'approve', input: approvalFor(awaiting) });
    expect(approved.result).toMatchObject({ state: 'approved', approvalId: 1 });
    expect(Date.parse(approved.result!.expiresAt!) - Date.now()).toBeGreaterThan(9 * 60_000);
    const activated = await applySkillCenterAction(agents, { kind: 'activate', revisionId: awaiting.revisionId });
    expect(activated.report!.revisions.find(item => item.revisionId === awaiting.revisionId)).toMatchObject({ state: 'active', active: true });

    const superseded = report.revisions.find(item => item.state === 'superseded')!;
    const rolled = await applySkillCenterAction(agents, { kind: 'rollback', packageId: superseded.packageId, revisionId: superseded.revisionId });
    const pkg = rolled.report!.revisions.filter(item => item.packageId === superseded.packageId);
    expect(pkg.find(item => item.active)?.revisionId).toBe(superseded.revisionId);
    const deactivated = await applySkillCenterAction(agents, { kind: 'deactivate', packageId: superseded.packageId });
    expect(deactivated.report!.revisions.some(item => item.packageId === superseded.packageId && item.active)).toBe(false);

    const review = report.revisions.find(item => item.state === 'review_required')!;
    const notYet = await applySkillCenterAction(agents, { kind: 'review', input: { revisionId: review.revisionId, treeSha256: review.treeSha256, decision: 'accept' } });
    expect(notYet.error).toContain('not available yet');
    const revoked = await applySkillCenterAction(agents, { kind: 'revoke', revisionId: review.revisionId });
    expect(revoked.result).toMatchObject({ state: 'revoked' });

    const offline = createMockPlatform({ seed: 'ready', host: 'bridge', skills: 'offline' }).capabilities.agents!;
    expect(await offline.skillRegistry()).toMatchObject({ mode: 'registry', status: 'unavailable', unavailableReason: 'binary_missing' });
  });
});

describe('Skill Security Center: scanner report and consent input', () => {
  const banner = (report: SkillRegistryReport, messages = t) => renderToStaticMarkup(SkillScannerBanner({ t: messages, report }));
  const inspector = (overrides: Partial<SkillScannerReport>): SkillScannerReport => ({
    scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable', ...overrides,
  });

  it('reflects the scanner the daemon reports', () => {
    // No scanner installed (the binary's default), or a host that does not report one: the generic warning.
    for (const report of [REPORT, { ...REPORT, inspector: inspector({}) }]) {
      const markup = banner(report);
      expect(markup).toContain('skill-center-banner warn');
      expect(markup).toContain('Imported skills stay quarantined until a verified scanner is configured.');
    }
    const unpinned = banner({ ...REPORT, inspector: inspector({ scannerId: 'skillspector', status: 'unpinned' }) });
    expect(unpinned).toContain('Scanner skillspector is installed, but its pin is not verified, so Extalia does not run it.');
    expect(unpinned).toContain('warn');
    const down = banner({ ...REPORT, inspector: inspector({ scannerId: 'skillspector', pinned: true, pin: 'abc+sha256:1', status: 'unavailable' }) });
    expect(down).toContain('The pinned scanner skillspector cannot run right now.');
    const ready = banner({ ...REPORT, scanner: 'pinned', inspector: inspector({ scannerId: 'skillspector', pinned: true, pin: 'abc+sha256:1', version: '1.0.0', status: 'ready' }) });
    expect(ready).toContain('Imported skills are inspected by skillspector 1.0.0.');
    expect(ready).toContain('Pin abc+sha256:1 · policy extalia.skill-policy.v1.');
    expect(ready).not.toContain('warn');
    expect(ready).not.toContain('stay quarantined');
    // The view renders the same banner.
    expect(html({ report: { ...REPORT, inspector: inspector({ scannerId: 'skillspector', status: 'unpinned' }) } })).toContain('its pin is not verified');
    expect(banner({ ...REPORT, inspector: inspector({ scannerId: 'skillspector', status: 'unpinned' }) }, MESSAGES.id)).toContain('pin-nya belum terverifikasi');
  });

  it('shows W0 consent as input only, with the project it came from', () => {
    const details: SkillRevisionDetails = {
      revision: QUARANTINED, manifest: '{}', files: [], inspections: [], approvals: [], history: [],
      consent: [
        { path: 'SKILL.md', sha256: hex('e'), allowedAt: '2026-10-21T08:00:00.000Z', workspaceId: 'w_mh3p2k1x9f04c2a7' },
        { path: 'SKILL.md', sha256: hex('e'), workspaceId: 'w_mh3p2k1x9f04c2a8' },
        { path: 'SKILL.md', sha256: hex('e'), allowedAt: '2026-10-22T08:00:00.000Z' },
      ],
    };
    const date = (iso: string) => new Date(iso).toLocaleDateString();
    const markup = renderToStaticMarkup(SkillDetails({ t, detail: details, workspaceNames: { w_mh3p2k1x9f04c2a7: 'Repo' } }));
    expect(markup).toContain(`Allowed in project Repo on ${date('2026-10-21T08:00:00.000Z')} (input only)`);
    expect(markup).toContain('Allowed in project w_mh3p2k1x9f04c2a8 on an unknown date (input only)');
    expect(markup).toContain(`Allowed in a project on ${date('2026-10-22T08:00:00.000Z')} (input only)`);
    expect(markup).toContain('never an approval');
    const id = renderToStaticMarkup(SkillDetails({ t: MESSAGES.id, detail: details, workspaceNames: { w_mh3p2k1x9f04c2a7: 'Repo' } }));
    expect(id).toContain(`Diizinkan di project Repo pada ${date('2026-10-21T08:00:00.000Z')} (hanya masukan)`);
    // The view passes the workspace names down to the details.
    const viewed = html({ details: { [QUARANTINED.revisionId]: details }, workspaceNames: { w_mh3p2k1x9f04c2a7: 'Repo' } });
    expect(viewed).toContain('Allowed in project Repo on');
  });

  it('says an interrupted inspection needs a new inspection (it is never replayed)', () => {
    expect(t.skillCenter.reasons['inspection-interrupted']).toBe('Inspection was interrupted; inspect again');
    expect(MESSAGES.id.skillCenter.reasons['inspection-interrupted']).toBe('Pemeriksaan terputus; periksa lagi');
    const interrupted = revision('notes', 'quarantined', { stateReason: 'inspection-interrupted' });
    expect(html({ report: { ...REPORT, revisions: [interrupted] } })).toContain('Inspection was interrupted; inspect again');
  });
});
