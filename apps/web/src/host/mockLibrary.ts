import {
  applyImport, deleteSession, displayTitle, emptyLibrary, PORTABLE_SESSION_FORMAT, previewImport, renameSession, setSessionState,
  type ImportMode, type PortableSession, type SessionLibrary,
} from '@extalia/core';
import type { AgentHostApi, ImportCandidate, ImportLocation, LibrarySessionSummary } from '@extalia/platform';

/**
 * Development-only native-history import for the mock host: fake locations
 * and conversations, applied to a real in-memory library with core's rules.
 */

const HOME = '/Users/you';
const LOCATIONS: ImportLocation[] = [
  { id: 'loc-codex', sourceId: 'codex', label: 'Codex', path: `${HOME}/.codex/sessions`, format: 'JSONL', available: true, supported: true },
  { id: 'loc-codex-archived', sourceId: 'codex', label: 'Codex (archived)', path: `${HOME}/.codex/archived_sessions`, format: 'JSONL', available: false, supported: true },
  { id: 'loc-claude', sourceId: 'claude-code', label: 'Claude Code', path: `${HOME}/.claude/projects`, format: 'JSONL', available: true, supported: true },
  { id: 'loc-hermes', sourceId: 'hermes', label: 'Hermes Agent', profile: 'default', path: `${HOME}/.hermes/state.db`, format: 'SQLite', available: true, supported: true },
  { id: 'loc-hermes-work', sourceId: 'hermes', label: 'Hermes Agent', profile: 'work', path: `${HOME}/.hermes/profiles/work/state.db`, format: 'SQLite', available: true, supported: true },
  { id: 'loc-gemini', sourceId: 'gemini-cli', label: 'Gemini CLI', path: `${HOME}/.gemini/tmp`, format: 'JSON / JSONL', available: false, supported: true },
  { id: 'loc-antigravity', sourceId: 'antigravity-ide', label: 'Antigravity IDE', path: `${HOME}/.gemini/antigravity/conversations`, format: 'Protocol Buffers', available: true, supported: false, note: 'Conversations are detected, but this version cannot read their binary format.' },
];

const SOURCE_NAMES: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', hermes: 'Hermes Agent', 'antigravity-ide': 'Antigravity IDE' };
const TOPICS: [string, string | undefined][] = [
  ['Refactor the auth middleware', `${HOME}/Projects/demo-app`],
  ['Why does the build fail on CI?', `${HOME}/Projects/demo-app`],
  ['Draft release notes for 2.4', `${HOME}/Projects/docs-site`],
  ['Summarize yesterday’s meeting notes', undefined],
  ['Add dark mode to the settings page', `${HOME}/Projects/demo-app`],
];

function candidatesFor(location: ImportLocation, now: number): ImportCandidate[] {
  if (!location.available) return [];
  const count = location.supported ? (location.sourceId === 'hermes' ? 2 : 3) : 1;
  return Array.from({ length: count }, (_, index) => {
    const [title, projectPath] = TOPICS[(location.id.length + index) % TOPICS.length]!;
    const native = `${location.id}-${index + 1}`;
    return {
      id: `cand-${native}`, sourceId: location.sourceId, locationId: location.id, sourceName: SOURCE_NAMES[location.sourceId] ?? location.sourceId,
      nativeSessionId: native, ...(location.profile ? { profile: location.profile } : {}), title, ...(projectPath ? { projectPath } : {}),
      updatedAt: new Date(now - (index + 1) * 7_200_000 - location.id.length * 600_000).toISOString(), format: location.format, supported: location.supported,
      ...(location.note ? { note: location.note } : {}),
    };
  });
}

function portable(candidate: ImportCandidate, mode: ImportMode): PortableSession {
  const end = Date.parse(candidate.updatedAt);
  const at = (minutesBefore: number) => new Date(end - minutesBefore * 60_000).toISOString();
  const name = candidate.projectPath?.split('/').pop();
  return {
    format: PORTABLE_SESSION_FORMAT,
    title: candidate.title,
    importMode: mode,
    provenance: { sourceId: candidate.sourceId, sourceSessionId: candidate.nativeSessionId, exportedAt: new Date().toISOString() },
    ...(name ? { workspace: { slug: name, name, ...(candidate.projectPath ? { projectLocation: candidate.projectPath } : {}) } } : {}),
    messages: [
      { index: 0, role: 'user', content: candidate.title, createdAt: at(12) },
      { index: 1, role: 'assistant', content: 'Let me look at the relevant files first.', createdAt: at(11) },
      { index: 2, role: 'tool', content: '$ rg -n "middleware" src\nsrc/server.ts:14: app.use(auth())\nsrc/auth.ts:3: export function auth() {', createdAt: at(10) },
      { index: 3, role: 'assistant', content: 'Here is what I found:\n\n1. `auth()` runs before **every** route.\n2. The token check repeats the parsing in `session.ts`.\n\n```ts\napp.use(\'/api\', auth());\n```\n\nShall I move it behind the `/api` prefix?', createdAt: at(9) },
      { index: 4, role: 'user', content: 'Yes, please do.', createdAt: at(2) },
      { index: 5, role: 'assistant', content: 'Done. Only `/api` routes check the token now; the health check stays public.', createdAt: at(1) },
    ],
    startedAt: at(12),
    lastMessageAt: at(1),
  };
}

const summarize = (library: SessionLibrary): LibrarySessionSummary[] => library.sessions.map(session => ({
  id: session.id,
  title: displayTitle(session),
  sourceId: session.provenance.sourceId,
  importMode: session.importMode,
  state: session.local.state,
  ...(session.workspace?.name ? { workspaceName: session.workspace.name } : {}),
  ...(session.workspace?.projectLocation ? { projectLocation: session.workspace.projectLocation } : {}),
  messageCount: session.messages.length,
  startedAt: session.startedAt,
  lastMessageAt: session.lastMessageAt,
}));

type LibraryMethods = Pick<AgentHostApi, 'importLocations' | 'scanImports' | 'previewImports' | 'commitImports' | 'importPortable' | 'librarySession' | 'organizeLibrarySession'>;

export function createMockLibrary(publish: (library: LibrarySessionSummary[]) => Promise<Awaited<ReturnType<AgentHostApi['getState']>>>, seed: boolean): { methods: LibraryMethods; summaries: () => LibrarySessionSummary[] } {
  let library = emptyLibrary();
  const scans = new Map<string, ImportCandidate[]>();
  let counter = 0;
  const now = Date.now();
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const pick = (scanId: string, ids: string[]) => {
    const candidates = scans.get(scanId);
    if (!candidates) throw new Error('This scan expired. Scan again.');
    return candidates.filter(item => ids.includes(item.id) && item.supported);
  };
  const json = (items: ImportCandidate[], mode: ImportMode) => JSON.stringify(items.map(item => portable(item, mode)));

  if (seed) {
    const seeded = LOCATIONS.slice(0, 4).flatMap(location => candidatesFor(location, now - 86_400_000)).slice(0, 5);
    library = applyImport(json(seeded, 'imported'), library).library;
    library = setSessionState(library, library.sessions[4]!.id, 'archived');
  }

  return {
    summaries: () => summarize(library),
    methods: {
      async importLocations() { await sleep(150); return structuredClone(LOCATIONS); },
      async scanImports(locationIds) {
        await sleep(700);
        const chosen = LOCATIONS.filter(location => !locationIds || locationIds.includes(location.id));
        const sessions = chosen.flatMap(location => candidatesFor(location, now));
        const scanId = `scan-${++counter}`;
        scans.set(scanId, sessions);
        const diagnostics = chosen.some(location => location.id === 'loc-hermes-work') ? [{ locationId: 'loc-hermes-work', message: 'Skipped 2 Hermes sessions without messages.' }] : [];
        return { scanId, sessions, diagnostics, truncated: false };
      },
      async previewImports(scanId, candidateIds, mode = 'imported') {
        await sleep(400);
        const items = pick(scanId, candidateIds);
        return { sessions: items.map(item => ({ candidateId: item.id, session: portable(item, mode) })), plan: previewImport(json(items, mode), library), diagnostics: [] };
      },
      async commitImports(scanId, candidateIds, mode = 'imported') {
        await sleep(400);
        const applied = applyImport(json(pick(scanId, candidateIds), mode), library);
        if (applied.preview.rejectionReason) throw new Error(applied.preview.rejectionReason);
        library = applied.library;
        return publish(summarize(library));
      },
      async importPortable(text) {
        await sleep(300);
        const applied = applyImport(text, library);
        if (!applied.preview.rejectionReason) library = applied.library;
        return { plan: applied.preview, state: await publish(summarize(library)) };
      },
      async librarySession(id) {
        await sleep(200);
        const session = library.sessions.find(item => item.id === id);
        if (!session) throw new Error('That conversation is no longer in the library.');
        return structuredClone(session);
      },
      async organizeLibrarySession(id, action, title) {
        await sleep(150);
        if (action === 'rename') library = renameSession(library, id, title ?? '');
        else if (action === 'delete') library = deleteSession(library, id);
        else library = setSessionState(library, id, action === 'archive' ? 'archived' : action === 'trash' ? 'trashed' : 'active');
        return publish(summarize(library));
      },
    },
  };
}
