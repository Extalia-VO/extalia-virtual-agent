import { sourceKey, type ImportPreview, type LocalState, type PortableSession } from '@extalia/core';
import type { ImportCandidate, ImportPreviewResult, LibrarySessionSummary } from '@extalia/platform';

/** Pure helpers for the Import and History pages. */

const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalize(fields.filter(Boolean).join(' '));
  return words.every(word => haystack.includes(word));
}

export function filterCandidates(candidates: readonly ImportCandidate[], query: string): ImportCandidate[] {
  return candidates.filter(item => matches(query, item.title, item.projectPath, item.sourceName, item.profile));
}

/** Supported candidates only; unsupported rows can never be selected. */
export const selectableIds = (candidates: readonly ImportCandidate[]) => candidates.filter(item => item.supported).map(item => item.id);

export interface LibraryGroup {
  /** Undefined collects conversations without a workspace ("Unassigned"). */
  workspaceName?: string;
  sessions: LibrarySessionSummary[];
}

/** Conversations in one state that match the search, grouped by workspace (Unassigned last), newest first. */
export function groupLibrary(items: readonly LibrarySessionSummary[], state: LocalState, query = ''): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  const visible = items
    .filter(item => item.state === state && matches(query, item.title, item.workspaceName, item.projectLocation, item.sourceId))
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  for (const item of visible) {
    const name = item.workspaceName?.trim() || undefined;
    const key = name ?? '';
    const group = groups.get(key) ?? { ...(name ? { workspaceName: name } : {}), sessions: [] };
    group.sessions.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.workspaceName) return 1;
    if (!b.workspaceName) return -1;
    return a.workspaceName.localeCompare(b.workspaceName);
  });
}

export function countByState(items: readonly LibrarySessionSummary[]): Record<LocalState, number> {
  const counts: Record<LocalState, number> = { active: 0, archived: 0, trashed: 0 };
  for (const item of items) counts[item.state]++;
  return counts;
}

export interface PreviewRow {
  candidateId: string;
  session: PortableSession;
  result?: ImportPreview['results'][number];
}

/** Pair each previewed session with what importing would do to it. */
export function previewRows(preview: ImportPreviewResult): PreviewRow[] {
  const results = new Map(preview.plan.results.map(result => [result.sourceKey, result]));
  return preview.sessions.map(({ candidateId, session }) => {
    const result = results.get(sourceKey(session.provenance));
    return result ? { candidateId, session, result } : { candidateId, session };
  });
}
