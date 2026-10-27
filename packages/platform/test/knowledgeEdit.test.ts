import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, KNOWLEDGE_EDIT_LIMITS, KNOWLEDGE_EDIT_METHODS, KNOWLEDGE_HOST_METHODS, KNOWLEDGE_NOTE_EDIT_METHODS, isAgentHostMethod, normalizeKnowledgeContent,
  normalizeKnowledgeMemoryImportRequest, normalizeKnowledgeNotePath, normalizeKnowledgeRollbackRequest, normalizeKnowledgeSha256, normalizeKnowledgeWriteRequest,
} from '../src/index.js';

const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64);

describe('Knowledge edit contract (W5 slice 2b)', () => {
  it('forwards the edit methods but keeps them out of the methods the page requires', () => {
    for (const method of KNOWLEDGE_EDIT_METHODS) expect(isAgentHostMethod(method)).toBe(true);
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining([...KNOWLEDGE_EDIT_METHODS]));
    for (const method of KNOWLEDGE_EDIT_METHODS) expect(KNOWLEDGE_HOST_METHODS as readonly string[]).not.toContain(method);
    expect(KNOWLEDGE_NOTE_EDIT_METHODS).toEqual(['readKnowledgeNote', 'writeKnowledgeNote', 'knowledgeHistory', 'rollbackKnowledgeNote']);
  });

  it('accepts note paths to .md files within the walker limits only', () => {
    expect(normalizeKnowledgeNotePath('Knowledge/N+1 Query.md')).toBe('Knowledge/N+1 Query.md');
    expect(normalizeKnowledgeNotePath('Inbox.MD')).toBe('Inbox.MD');
    for (const bad of ['Knowledge/Topic', 'Knowledge/.md', '.hidden/Note.md', '../Note.md', '/abs.md', 'a\\b.md', 'a//b.md', 'Note.md\n', 42, null]) {
      expect(() => normalizeKnowledgeNotePath(bad)).toThrow(/note path/i);
    }
    expect(() => normalizeKnowledgeNotePath(`${Array.from({ length: KNOWLEDGE_EDIT_LIMITS.folders + 1 }, () => 'f').join('/')}/n.md`)).toThrow(/ends in \.md/);
    expect(normalizeKnowledgeNotePath(`${Array.from({ length: KNOWLEDGE_EDIT_LIMITS.folders }, () => 'f').join('/')}/n.md`)).toContain('n.md');
    // 1024 bytes, counted in UTF-8 (é is two bytes).
    expect(() => normalizeKnowledgeNotePath(`${'é'.repeat(511)}.md`)).toThrow(/ends in \.md/);
  });

  it('bounds note text and version hashes', () => {
    expect(normalizeKnowledgeSha256(HASH)).toBe(HASH);
    for (const bad of [HASH.toUpperCase(), 'a'.repeat(63), `${HASH}0`, 'g'.repeat(64), null]) expect(() => normalizeKnowledgeSha256(bad)).toThrow(/Invalid note version/);
    expect(normalizeKnowledgeContent('---\nmanaged_by: extalia\n---\n# Hi\n')).toContain('# Hi');
    expect(normalizeKnowledgeContent('')).toBe('');
    expect(() => normalizeKnowledgeContent('a\u0000b')).toThrow(/Invalid note text/);
    expect(() => normalizeKnowledgeContent(5)).toThrow(/Invalid note text/);
    expect(normalizeKnowledgeContent('x'.repeat(KNOWLEDGE_EDIT_LIMITS.contentBytes))).toHaveLength(KNOWLEDGE_EDIT_LIMITS.contentBytes);
    expect(() => normalizeKnowledgeContent('x'.repeat(KNOWLEDGE_EDIT_LIMITS.contentBytes + 1))).toThrow(/larger than 256 KiB/);
    expect(() => normalizeKnowledgeContent('€'.repeat(KNOWLEDGE_EDIT_LIMITS.contentBytes / 3 + 1))).toThrow(/larger than/);
  });

  it('requires every write to name the version it replaces (null only to create)', () => {
    expect(normalizeKnowledgeWriteRequest({ path: 'A.md', content: 'x', expectedSha256: HASH, author: 'extalia:memory-import' })).toEqual({ path: 'A.md', content: 'x', expectedSha256: HASH });
    expect(normalizeKnowledgeWriteRequest({ path: 'New.md', content: '# New\n', expectedSha256: null })).toEqual({ path: 'New.md', content: '# New\n', expectedSha256: null });
    expect(() => normalizeKnowledgeWriteRequest({ path: 'A.md', content: 'x' })).toThrow(/name the version/);
    expect(() => normalizeKnowledgeWriteRequest({ path: 'A.md', content: 'x', expectedSha256: 'abc' })).toThrow(/Invalid note version/);
    expect(() => normalizeKnowledgeWriteRequest({ path: 'A.txt', content: 'x', expectedSha256: null })).toThrow(/ends in \.md/);
    expect(() => normalizeKnowledgeWriteRequest('A.md')).toThrow(/Invalid note write/);
  });

  it('validates rollbacks and memory imports (preview unless dryRun is false)', () => {
    expect(normalizeKnowledgeRollbackRequest({ path: 'A.md', toSha256: OTHER, expectedSha256: HASH })).toEqual({ path: 'A.md', toSha256: OTHER, expectedSha256: HASH });
    expect(() => normalizeKnowledgeRollbackRequest({ path: 'A.md', toSha256: OTHER })).toThrow(/name the version/);
    // `null`: the note was deleted and is restored from its history.
    expect(normalizeKnowledgeRollbackRequest({ path: 'A.md', toSha256: OTHER, expectedSha256: null }).expectedSha256).toBeNull();
    expect(() => normalizeKnowledgeRollbackRequest({ path: 'A.md', toSha256: 'x', expectedSha256: HASH })).toThrow(/Invalid note version/);
    expect(() => normalizeKnowledgeRollbackRequest(null)).toThrow(/Invalid rollback/);
    expect(normalizeKnowledgeMemoryImportRequest({ workspaceId: 'w_mabc12345678' })).toEqual({ workspaceId: 'w_mabc12345678', dryRun: true });
    expect(normalizeKnowledgeMemoryImportRequest({ workspaceId: 'workspace-1', dryRun: false })).toEqual({ workspaceId: 'workspace-1', dryRun: false });
    expect(normalizeKnowledgeMemoryImportRequest({ workspaceId: '0b7c7f3e-0000-4000-8000-000000000000', dryRun: true }).dryRun).toBe(true);
    for (const bad of [{ workspaceId: '../x' }, { workspaceId: '' }, { workspaceId: 'a'.repeat(65) }, {}]) expect(() => normalizeKnowledgeMemoryImportRequest(bad)).toThrow(/Choose a workspace/);
    expect(() => normalizeKnowledgeMemoryImportRequest({ workspaceId: 'w_1', dryRun: 'yes' })).toThrow(/Invalid memory import/);
  });
});
