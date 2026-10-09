import { describe, expect, it } from 'vitest';
import {
  PORTABLE_SESSION_FORMAT, applyImport, decodeLibrary, deleteSession, displayTitle, emptyLibrary, exportSessions,
  moveSession, previewImport, renameSession, setSessionState, type PortableSession,
} from '../src/index.js';

const T0 = '2026-01-31T10:00:00.000Z';
const T1 = '2026-01-31T10:05:00.000Z';

function session(sourceSessionId: string, overrides: Partial<PortableSession> = {}): PortableSession {
  return {
    format: PORTABLE_SESSION_FORMAT,
    title: `Session ${sourceSessionId}`,
    importMode: 'imported',
    provenance: { sourceId: 'demo', sourceSessionId, exportedAt: T1 },
    workspace: { slug: 'example', name: 'Example' },
    messages: [
      { index: 0, role: 'user', content: 'Plan the change.', createdAt: T0 },
      { index: 1, role: 'assistant', content: 'Here is a plan.', createdAt: T1 },
    ],
    startedAt: T0,
    lastMessageAt: T1,
    ...overrides,
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe('import', () => {
  it('previews without changing anything and matches the applied result', () => {
    const input = json([session('a'), session('b')]);
    const library = emptyLibrary();
    const preview = previewImport(input, library, { now: T1 });
    const applied = applyImport(input, library, { now: T1 });
    expect(library.sessions).toHaveLength(0);
    expect(applied.preview).toEqual(preview);
    expect(preview).toMatchObject({ addCount: 2, updateCount: 0, skipCount: 0 });
    expect(applied.library.sessions.map(item => item.id)).toEqual(['demo:a', 'demo:b']);
  });

  it('keeps distinct source sessions apart and identifies sessions by source, not by position', () => {
    const other = session('a', { provenance: { sourceId: 'other-tool', sourceSessionId: 'a', exportedAt: T1 } });
    const { library } = applyImport(json([session('a'), other]));
    expect(library.sessions.map(item => item.id)).toEqual(['demo:a', 'other-tool:a']);
  });

  it('deduplicates within a batch and across repeated imports', () => {
    const first = applyImport(json([session('a'), session('a')]));
    expect(first.preview).toMatchObject({ addCount: 1, skipCount: 1 });
    const second = applyImport(json(session('a')), first.library);
    expect(second.preview).toMatchObject({ addCount: 0, updateCount: 1 });
    expect(second.library.sessions).toHaveLength(1);
  });

  it('refreshes content on re-import while preserving local organization', () => {
    let { library } = applyImport(json(session('a')));
    library = renameSession(library, 'demo:a', 'My title', T1);
    library = moveSession(library, 'demo:a', 'workspace-1', T1);
    library = setSessionState(library, 'demo:a', 'archived', T1);
    const updated = session('a', { title: 'New source title' });
    library = applyImport(json(updated), library).library;
    const [stored] = library.sessions;
    expect(stored?.title).toBe('New source title');
    expect(stored && displayTitle(stored)).toBe('My title');
    expect(stored?.local).toMatchObject({ state: 'archived', workspaceId: 'workspace-1' });
  });

  it('skips linked sessions the user trashed until they are restored', () => {
    const linked = session('l', { importMode: 'linked' });
    let { library } = applyImport(json(linked));
    library = setSessionState(library, 'demo:l', 'trashed', T1);
    expect(library.exclusions).toEqual(['demo:l']);
    expect(applyImport(json(linked), library).preview).toMatchObject({ skipCount: 1 });
    library = setSessionState(library, 'demo:l', 'active', T1);
    expect(library.exclusions).toEqual([]);
    expect(applyImport(json(linked), library).preview).toMatchObject({ updateCount: 1 });
  });

  it('keeps a tombstone when a linked session is deleted permanently', () => {
    const linked = session('l', { importMode: 'linked' });
    let { library } = applyImport(json(linked));
    library = deleteSession(library, 'demo:l');
    expect(library.sessions).toHaveLength(0);
    expect(applyImport(json(linked), library).preview).toMatchObject({ skipCount: 1, addCount: 0 });
  });

  it('refuses an invalid batch atomically', () => {
    const broken = { ...session('b'), messages: [{ index: 1, role: 'user', content: 'x', createdAt: T0 }] };
    const library = applyImport(json(session('a'))).library;
    const result = applyImport(json([session('c'), broken]), library);
    expect(result.preview.rejectionReason).toMatch(/Session 2/);
    expect(result.library).toBe(library);
  });

  it('refuses structured credentials, bad dates, unknown roles and disabled sources', () => {
    const cases = [
      { ...session('a'), apiKey: 'value' },
      session('a', { startedAt: '2026-02-30T00:00:00.000Z' }),
      { ...session('a'), messages: [{ index: 0, role: 'robot', content: 'x', createdAt: T0 }] },
    ];
    for (const item of cases) expect(previewImport(json(item)).rejectionReason).toBeTruthy();
    expect(previewImport(json(session('a')), emptyLibrary(), { allowedSources: ['codex'] }).rejectionReason).toMatch(/not enabled/);
  });

  it('masks likely credentials in message text and reports them in the preview', () => {
    // Fake credential for the redaction test. extalia-allow-secret
    const leaky = session('a', { messages: [{ index: 0, role: 'user', content: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx', createdAt: T0 }] }); // extalia-allow-secret
    const { library, preview } = applyImport(json(leaky));
    expect(preview.results[0]?.redactions).toBeGreaterThan(0);
    expect(library.sessions[0]?.messages[0]?.content).not.toContain('abcdefghijklmnop');
  });

  it('keeps code and tool output as inert text', () => {
    const code = session('a', { messages: [{ index: 0, role: 'tool', content: 'rm -rf build && echo "done"', createdAt: T0 }] });
    expect(applyImport(json(code)).library.sessions[0]?.messages[0]?.content).toBe('rm -rf build && echo "done"');
  });
});

describe('stored library', () => {
  it('round-trips through JSON', () => {
    let { library } = applyImport(json([session('a'), session('l', { importMode: 'linked' })]));
    library = setSessionState(library, 'demo:l', 'trashed', T1);
    const decoded = decodeLibrary(JSON.parse(JSON.stringify(library)));
    expect(decoded).toEqual({ ok: true, value: library });
  });

  it('rejects duplicate identities and mismatched linked exclusions', () => {
    const { library } = applyImport(json([session('a'), session('l', { importMode: 'linked' })]));
    const duplicated = { ...library, sessions: [...library.sessions, library.sessions[0]] };
    const mismatched = { ...library, exclusions: ['demo:l'] };
    expect(decodeLibrary(duplicated).ok).toBe(false);
    expect(decodeLibrary(mismatched).ok).toBe(false);
  });

  it('exports portable sessions without local organization', () => {
    let { library } = applyImport(json(session('a')));
    library = renameSession(library, 'demo:a', 'Local name', T1);
    const [exported] = exportSessions(library);
    expect(exported).toEqual(session('a'));
    expect(applyImport(json(exportSessions(library))).preview.addCount).toBe(1);
  });
});
