import { describe, expect, it } from 'vitest';
import { DAEMON_KNOWLEDGE_LIMITS, encodeDaemonFrame, parseDaemonFrame, type DaemonFrame } from '../src/index.js';

const node = { nodeId: 'path:Base.md', path: 'Base.md', title: 'Original', kind: 'note', aliases: [], tags: [],
  idFromFrontMatter: false, origin: 'vault', trustStatus: 'untrusted', sourceSha256: 'a'.repeat(64),
  observedAt: '2026-01-01T00:00:00.000Z', declaredSourceTaskIds: [] };
const update = { nodeId: 'path:Update.md', path: 'Update.md', title: 'Amendment', relation: 'updates', line: 2,
  sourceSha256: 'b'.repeat(64), excerpt: 'Updates: [[Base]] — revised observation', trustStatus: 'untrusted' };
const frame = (relatedUpdates?: unknown) => ({ schemaVersion: 1, kind: 'response', requestId: '00000000-0000-4000-8000-000000000100', op: 'knowledge.node',
  result: { generation: 1, node, body: '# Original\nEarlier finding', bodyStatus: 'current', bodyTruncated: false,
    ...(relatedUpdates === undefined ? {} : { relatedUpdates, relatedUpdatesTruncated: false }) } });

describe('Knowledge amendment recall contract', () => {
  it('retains older-daemon reads and carries bounded untrusted amendment/conflict evidence', () => {
    expect(parseDaemonFrame(frame()).ok).toBe(true);
    for (const relation of ['updates', 'contradicts', 'supersedes']) {
      const value = frame([{ ...update, relation }]);
      expect(parseDaemonFrame(value).ok).toBe(true);
      expect(encodeDaemonFrame(value as DaemonFrame).length).toBeGreaterThan(0);
    }
    const max = Array.from({ length: DAEMON_KNOWLEDGE_LIMITS.relatedUpdates }, () => ({ ...update,
      excerpt: 'x'.repeat(DAEMON_KNOWLEDGE_LIMITS.relatedUpdateExcerpt) }));
    expect(parseDaemonFrame(frame(max)).ok).toBe(true);
    expect(parseDaemonFrame(frame([...max, update])).ok).toBe(false);
  });
  it('rejects invented authority, invalid locations, unbounded excerpts and malformed hashes', () => {
    for (const replacement of [{ trustStatus: 'verified' }, { relation: 'authoritative' }, { path: '../Other.md' },
      { line: 0 }, { sourceSha256: 'bad' }, { excerpt: 'x'.repeat(DAEMON_KNOWLEDGE_LIMITS.relatedUpdateExcerpt + 1) }])
      expect(parseDaemonFrame(frame([{ ...update, ...replacement }])).ok).toBe(false);
  });
});
