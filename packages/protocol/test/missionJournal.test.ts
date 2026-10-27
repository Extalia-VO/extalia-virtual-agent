import { describe, expect, it } from 'vitest';
import {
  isJournalEditTarget, journalEditTarget, MISSION_JOURNAL_ACTIVITY, missionJournalAdmissionJson, missionJournalRole, parseOrchestration, protocolContractFiles,
} from '../src/index.js';
import committed from '../schemas/journal-admission.json' with { type: 'json' };
import fixture from './fixtures/journal/admission.json' with { type: 'json' };

type Body = Parameters<typeof missionJournalRole>[0];

describe('mission journal admission (ADR 0014, ADR 0028)', () => {
  it('matches the committed journal-admission.json the Rust daemon embeds', () => {
    expect(committed).toEqual(JSON.parse(protocolContractFiles()['journal-admission.json']!));
    expect(committed).toEqual(JSON.parse(JSON.stringify(missionJournalAdmissionJson())));
    // A write worker may do everything a read-only worker may, plus edits.
    for (const key of ['agentActivities', 'toolKinds'] as const) {
      expect(MISSION_JOURNAL_ACTIVITY['write-worker'][key]).toEqual(expect.arrayContaining([...MISSION_JOURNAL_ACTIVITY['read-only-worker'][key]]));
    }
    expect(MISSION_JOURNAL_ACTIVITY['read-only-worker'].agentActivities).not.toContain('edit');
    expect(MISSION_JOURNAL_ACTIVITY['read-only-worker'].toolKinds).not.toContain('edit');
  });

  it('gives the shared fixture verdicts', () => {
    expect(fixture.contract).toBe('missionJournalRole');
    for (const item of fixture.cases) {
      expect(missionJournalRole(item.body as Body) ?? null, item.name).toBe(item.role);
      // Admitted bodies are valid contract bodies; a refused one may already fail the contract (an empty target).
      if (item.role !== null) expect(parseOrchestration('agentEvent', {
        schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003', missionId: '00000000-0000-4000-8000-000000000006',
        taskId: '00000000-0000-4000-8000-000000000004', agentId: '00000000-0000-4000-8000-000000000005', source: { runtime: 'extalia-native', channel: 'system' },
        observedAt: '2026-01-01T00:00:00.000Z', confidence: 'reported', body: item.body,
      }).ok, item.name).toBe(true);
    }
    expect(fixture.cases.filter(item => item.role === 'write-worker').length).toBeGreaterThan(3);
    expect(fixture.cases.filter(item => item.role === null).length).toBeGreaterThan(10);
  });

  it('normalizes model paths into worktree-relative targets or drops them', () => {
    expect(journalEditTarget('src/app.ts')).toBe('src/app.ts');
    expect(journalEditTarget('./src//app.ts/')).toBe('src/app.ts');
    expect(journalEditTarget('src\\win\\file.ts')).toBe('src/win/file.ts');
    for (const raw of ['/etc/passwd', '\\\\server\\share', '../x', 'a/../b', 'C:\\x', '', '.', 'caf\u00e9', 'a'.repeat(241), 42, undefined]) {
      expect(journalEditTarget(raw), String(raw)).toBeUndefined();
    }
    expect(isJournalEditTarget('a/b c/d.ts')).toBe(true);
    expect(isJournalEditTarget('a/ b')).toBe(false);
  });
});
