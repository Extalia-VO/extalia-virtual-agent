import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, SKILL_APPROVAL_TTL_MS, SKILL_USER_PRINCIPAL, isAgentHostMethod, normalizeSkillApproval, normalizeSkillApprovalId, normalizeSkillImportSource,
  normalizeSkillPackageId, normalizeSkillReview, normalizeSkillRevisionId,
} from '../src/index.js';

const REVISION = `skr_${'a'.repeat(64)}`;
const HEX = 'b'.repeat(64);

describe('Skill Security Center contract (W3)', () => {
  it('forwards every Security Center method through Desktop IPC and the Bridge', () => {
    const methods = ['skillRegistry', 'inspectSkill', 'importSkill', 'reviewSkill', 'approveSkill', 'activateSkill', 'deactivateSkill', 'rollbackSkill', 'revokeSkill'];
    for (const method of methods) expect(isAgentHostMethod(method)).toBe(true);
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(methods));
    expect(SKILL_USER_PRINCIPAL).toBe('user:local');
    expect(SKILL_APPROVAL_TTL_MS).toBe(10 * 60_000);
  });

  it('validates revision ids, package ids and approval ids', () => {
    expect(normalizeSkillRevisionId(REVISION)).toBe(REVISION);
    for (const bad of ['skr_' + 'A'.repeat(64), 'skr_abc', REVISION + 'a', 42, undefined]) expect(() => normalizeSkillRevisionId(bad)).toThrow(/Invalid skill revision/);
    expect(normalizeSkillPackageId('release-notes')).toBe('release-notes');
    for (const bad of ['Release', '../x', '-x', 'a'.repeat(65), null]) expect(() => normalizeSkillPackageId(bad)).toThrow(/Invalid skill package/);
    expect(normalizeSkillApprovalId(3)).toBe(3);
    for (const bad of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) expect(() => normalizeSkillApprovalId(bad)).toThrow(/Invalid skill approval/);
  });

  it('accepts absolute folders and workspace skills only, with bounded text', () => {
    expect(normalizeSkillImportSource({ kind: 'folder', path: '/Users/me/skills/notes' })).toEqual({ kind: 'folder', path: '/Users/me/skills/notes' });
    expect(normalizeSkillImportSource({ kind: 'folder', path: 'C:\\skills\\notes' })).toEqual({ kind: 'folder', path: 'C:\\skills\\notes' });
    expect(() => normalizeSkillImportSource({ kind: 'folder', path: 'skills/notes' })).toThrow(/full path/);
    expect(() => normalizeSkillImportSource({ kind: 'folder', path: '' })).toThrow(/Choose a skill folder/);
    expect(() => normalizeSkillImportSource({ kind: 'folder', path: '/tmp/a\u0000b' })).toThrow(/Invalid folder path/);
    expect(() => normalizeSkillImportSource({ kind: 'folder', path: '/' + 'a'.repeat(5000) })).toThrow(/Invalid folder path/);
    expect(normalizeSkillImportSource({ kind: 'workspace', workspaceId: 'w_1', name: 'deploy', extra: true })).toEqual({ kind: 'workspace', workspaceId: 'w_1', name: 'deploy' });
    expect(() => normalizeSkillImportSource({ kind: 'workspace', workspaceId: 'w_1', name: '../../etc' })).toThrow(/Invalid skill name/);
    expect(() => normalizeSkillImportSource({ kind: 'workspace', workspaceId: '', name: 'deploy' })).toThrow(/Choose a workspace/);
    expect(() => normalizeSkillImportSource({ kind: 'path', path: '/x' })).toThrow(/Choose where/);
    expect(() => normalizeSkillImportSource(null)).toThrow(/Choose where/);
  });

  it('carries exactly the digests shown in an approval and refuses malformed ones', () => {
    expect(normalizeSkillApproval({ revisionId: REVISION, treeSha256: HEX, permissionDigest: 'c'.repeat(64), principal: 'model:x', expiresAt: '2099-01-01T00:00:00Z' }))
      .toEqual({ revisionId: REVISION, treeSha256: HEX, permissionDigest: 'c'.repeat(64) });
    expect(() => normalizeSkillApproval({ revisionId: REVISION, treeSha256: HEX.toUpperCase(), permissionDigest: HEX })).toThrow(/package hash/);
    expect(() => normalizeSkillApproval({ revisionId: REVISION, treeSha256: HEX, permissionDigest: 'x' })).toThrow(/permission digest/);
    expect(() => normalizeSkillApproval({ treeSha256: HEX, permissionDigest: HEX })).toThrow(/revision/);
  });

  it('validates a review decision and its note', () => {
    expect(normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'accept' })).toEqual({ revisionId: REVISION, treeSha256: HEX, decision: 'accept' });
    expect(normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'reject', note: 'Too broad.\nAsks for network.' }))
      .toEqual({ revisionId: REVISION, treeSha256: HEX, decision: 'reject', note: 'Too broad.\nAsks for network.' });
    expect(normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'accept', note: '   ' })).not.toHaveProperty('note');
    expect(() => normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'approve' })).toThrow(/accept or reject/);
    expect(() => normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'accept', note: 'x'.repeat(2001) })).toThrow(/at most 2000/);
    expect(() => normalizeSkillReview({ revisionId: REVISION, treeSha256: HEX, decision: 'accept', note: 'bell\u0007' })).toThrow(/plain text/);
  });
});
