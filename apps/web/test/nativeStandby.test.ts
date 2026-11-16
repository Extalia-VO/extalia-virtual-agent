import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { NativeStandbyRotation, nativeStandbySessionIds } from '../src/office/nativeStandby';
import { projectOfficePresence, subagentLingerMs, type OfficeAgent, type PresenceTeams } from '../src/office/presence';

const session = (id = 'native', size = 10, workspaceId = id): SessionSummary => ({
  id, workspaceId, connectionId: 'connection', title: 'Team', control: 'managed',
  createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-01T00:00:00.000Z', running: false,
  team: { enabled: true, size },
});
const roster = (target: SessionSummary): NonNullable<ReturnType<PresenceTeams['get']>> => Array.from({ length: target.team!.size }, (_, index) => ({
  id: `member-${index}`, name: `Member ${index}`, gender: index % 2 ? 'female' : 'male', model: `model-${index}`,
}));
const fixture = (targets: SessionSummary[]) => ({
  sessions: targets,
  teams: new Map(targets.map(target => [target.id, roster(target)])),
  presences: projectOfficePresence(targets, []),
});
const worker = (target: SessionSummary, index: number, overrides: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id: `${target.id}:member-${index}`, sessionId: target.id, agentId: `member-${index}`, displayName: `Member ${index}`,
  control: 'managed', status: 'working', running: true, parentId: `${target.id}:primary`, ...overrides,
});
const shifts = (rows: readonly OfficeAgent[]) => rows.filter(row => row.nativeStandby === 'on-shift');
const ids = (rows: readonly OfficeAgent[]) => shifts(rows).map(row => row.id);

describe('Native standby attendance', () => {
  it.each([[10, 3], [20, 4], [32, 5]])('rotates every member of a team of %i through %i standby slots', (size, floor) => {
    const rotation = new NativeStandbyRotation();
    const input = fixture([session('native', size)]);
    const seen = new Set<string>();
    let previous: string[] = [];
    for (let cycle = 0; cycle <= size; cycle++) {
      const rows = rotation.project({ ...input, now: cycle * 21 * 60_000 });
      const current = ids(rows);
      expect(current).toHaveLength(floor);
      expect(rows.filter(row => row.status !== 'offline')).toHaveLength(floor + 1);
      expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
      if (cycle > 0) expect(current.every(id => !previous.includes(id))).toBe(true);
      for (const id of current) seen.add(id);
      previous = current;
    }
    expect(seen.size).toBe(size);
  });

  it('keeps shifts stable until their individual linger duration, including backwards time', () => {
    const rotation = new NativeStandbyRotation();
    const input = fixture([session()]);
    const first = rotation.project({ ...input, now: 1000 });
    const earliest = Math.min(...ids(first).map(id => subagentLingerMs(id)));
    expect(ids(rotation.project({ ...input, now: 1000 + earliest - 1 }))).toEqual(ids(first));
    const rotated = rotation.project({ ...input, now: 1000 + earliest });
    const expired = ids(first).filter(id => subagentLingerMs(id) === earliest);
    expect(expired.every(id => !ids(rotated).includes(id))).toBe(true);
    expect(ids(rotation.project({ ...input, now: 1000 }))).toEqual(ids(rotated));
    expect(shifts(rotated).every(row => row.status === 'idle' && !row.running && !row.activity && !row.phase)).toBe(true);
  });

  it('caps synthetic attendance across workspaces and serves other teams on rotation', () => {
    const rotation = new NativeStandbyRotation();
    const input = fixture(Array.from({ length: 7 }, (_, index) => session(`team-${index}`)));
    const first = rotation.project({ ...input, now: 0 });
    expect(shifts(first)).toHaveLength(5);
    expect(new Set(shifts(first).map(row => row.sessionId)).size).toBe(5);
    const next = rotation.project({ ...input, sessions: [...input.sessions].reverse(), now: 21 * 60_000 });
    expect(shifts(next)).toHaveLength(5);
    const served = new Set([...shifts(first), ...shifts(next)].map(row => row.sessionId));
    expect(served.size).toBe(7);
  });

  it('counts actual members toward the floor and never forces working members off duty', () => {
    const target = session();
    const input = fixture([target]);
    const rotation = new NativeStandbyRotation();
    const first = rotation.project({ ...input, now: 0 });
    const actual = roster(target).map((_, index) => worker(target, index));
    const rows = rotation.project({ ...input, presences: [...input.presences, ...actual], now: 1000 });
    expect(shifts(first)).toHaveLength(3);
    expect(shifts(rows)).toHaveLength(0);
    for (const row of actual) expect(rows.find(candidate => candidate.id === row.id)).toBe(row);
    const other = session('other');
    const combined = fixture([target, other]);
    const busyRows = rotation.project({ ...combined, presences: [...combined.presences, ...actual], now: 21 * 60_000 });
    expect(shifts(busyRows)).toHaveLength(3);
    expect(busyRows.filter(row => row.status === 'working')).toHaveLength(10);
  });

  it('replaces an actual lingering worker with a different member once it leaves', () => {
    const target = session();
    const input = fixture([target]);
    const rotation = new NativeStandbyRotation();
    const event = (seq: number, body: EventBody) => createEvent({
      id: `event-${seq}`, sessionId: target.id, agentId: 'member-0', seq,
      at: new Date(seq * 1000).toISOString(), source: { runtime: 'extalia-native', channel: 'stream' }, body,
    });
    const started = [event(1, { type: 'subagent.spawned', subagentId: 'member-0', label: 'Member 0' }),
      event(2, { type: 'agent.state', state: 'working' })];
    const stopped = [...started, event(3, { type: 'agent.stopped' })];
    const busy = projectOfficePresence([{ ...target, running: true }], started, 2000, input.teams);
    expect(shifts(rotation.project({ ...input, presences: busy, now: 2000 }))).toHaveLength(2);
    const lingering = projectOfficePresence([target], stopped, 3000, input.teams);
    expect(lingering.find(row => row.agentId === 'member-0')?.status).toBe('idle');
    const during = rotation.project({ ...input, presences: lingering, now: 3000 });
    expect(during.find(row => row.agentId === 'member-0')).toBe(lingering.find(row => row.agentId === 'member-0'));
    const after = 3001 + subagentLingerMs('native:member-0');
    const departed = projectOfficePresence([target], stopped, after, input.teams);
    expect(departed.find(row => row.agentId === 'member-0')?.status).toBe('offline');
    const rows = rotation.project({ ...input, presences: departed, now: after });
    expect(shifts(rows)).toHaveLength(3);
    expect(rows.find(row => row.agentId === 'member-0')?.nativeStandby).toBe('off-shift');
    expect(ids(rows)).not.toContain('native:member-0');
  });

  it('uses configured identity and model for synthetic rows without runtime activity', () => {
    const target = session();
    const input = fixture([target]);
    const rows = new NativeStandbyRotation().project({ ...input, now: 0 });
    expect(rows.find(row => row.agentId === 'member-0')).toMatchObject({
      parentId: 'native:primary', displayName: 'Member 0', model: 'model-0', running: false,
      look: { seed: 'name:member 0', presentation: 'masculine' }, origin: { mark: 'extalia-native' },
    });
    expect(rows.filter(row => row.nativeStandby === 'off-shift')).toHaveLength(7);
    expect(input.presences).toHaveLength(1);
  });

  it('retains actual errors, unknowns, approvals, meetings and mission workers unchanged', () => {
    const target = session();
    const input = fixture([target]);
    const protectedRows: OfficeAgent[] = [
      worker(target, 0, { status: 'idle', phase: 'error', running: false }),
      worker(target, 1, { status: 'offline', phase: 'error', running: false }),
      worker(target, 2, { status: 'offline', stalled: true, running: false }),
      worker(target, 3, { status: 'stopping' }),
      worker(target, 4, { status: 'waiting', pendingApprovalId: 'approval' }),
      worker(target, 5, { status: 'blocked', mission: { missionId: 'mission', state: 'unknown', admitted: true } }),
      worker(target, 6, { status: 'idle', running: false, mission: { missionId: 'queued', state: 'queued', admitted: false } }),
      worker(target, 7, { status: 'offline', running: false, mission: { missionId: 'failed', state: 'failed', admitted: true } }),
      worker(target, 8, { status: 'working', meeting: { meetingId: 'meeting', participants: ['member-8'] } }),
      worker(target, 9, { status: 'offline', running: false, phase: 'ended' }),
    ];
    const rows = new NativeStandbyRotation().project({ ...input, presences: [...input.presences, ...protectedRows], now: 0 });
    expect(shifts(rows)).toHaveLength(0);
    for (const row of protectedRows) expect(rows.find(candidate => candidate.id === row.id)).toBe(row);
  });

  it('does not revive a protected offline member when attendance is otherwise empty', () => {
    const target = session();
    const input = fixture([target]);
    const error = worker(target, 0, { status: 'offline', running: false, phase: 'error' });
    const rows = new NativeStandbyRotation().project({ ...input, presences: [...input.presences, error], now: 0 });
    expect(shifts(rows)).toHaveLength(3);
    expect(rows.find(row => row.id === error.id)).toBe(error);
    expect(ids(rows)).not.toContain(error.id);
  });

  it('selects only the latest eligible Native session per workspace, preferring a running session', () => {
    const older = session('older', 10, 'workspace');
    const latest = { ...session('latest', 10, 'workspace'), lastActiveAt: '2026-11-02T00:00:00.000Z' };
    const input = fixture([older, latest]);
    const rotation = new NativeStandbyRotation();
    expect(shifts(rotation.project({ ...input, now: 0 })).every(row => row.sessionId === latest.id)).toBe(true);
    const running = { ...older, running: true };
    const result = rotation.project({ ...input, sessions: [latest, running], now: 1000 });
    expect(shifts(result)).toHaveLength(3);
    expect(shifts(result).every(row => row.sessionId === older.id)).toBe(true);
  });

  it.each(['disabled', 'ended', 'offline'] as const)('does not fall back to a historic team when the newest is %s', kind => {
    const older = session('older', 10, 'workspace');
    const latest = { ...session('latest', 10, 'workspace'), lastActiveAt: '2026-11-02T00:00:00.000Z' };
    const rotation = new NativeStandbyRotation();
    const original = fixture([older]);
    expect(shifts(rotation.project({ ...original, now: 0 }))).toHaveLength(3);
    if (kind === 'disabled') latest.team!.enabled = false;
    const input = fixture([older, latest]);
    const lead = input.presences.find(row => row.sessionId === latest.id)!;
    if (kind === 'ended') lead.phase = 'ended';
    if (kind === 'offline') lead.status = 'offline';
    expect(shifts(rotation.project({ ...input, now: 1000 }))).toHaveLength(0);
  });

  it.each(['hermes', 'observed', 'disabled', 'offline', 'earlier', 'ended'] as const)('excludes %s sessions', kind => {
    let target = session();
    if (kind === 'hermes') target = { ...target, runtime: { id: 'hermes', profile: 'default' } };
    if (kind === 'observed') target = { ...target, control: 'observed' };
    if (kind === 'disabled') target = { ...target, team: { enabled: false, size: 10 } };
    const input = fixture([target]);
    if (kind === 'offline') input.presences[0]!.status = 'offline';
    if (kind === 'earlier') input.presences[0]!.earlier = true;
    if (kind === 'ended') input.presences[0]!.phase = 'ended';
    const rows = new NativeStandbyRotation().project({ ...input, now: 0 });
    expect(rows).toEqual(input.presences);
  });

  it('prunes roster edits and session removals, and resets all shift history explicitly', () => {
    const rotation = new NativeStandbyRotation();
    const target = session();
    const input = fixture([target]);
    const first = rotation.project({ ...input, now: 0 });
    const removed = shifts(first)[0]!;
    const editedTeams = new Map([[target.id, roster(target).filter(member => member.id !== removed.agentId)]]);
    const edited = rotation.project({ ...input, teams: editedTeams, now: 1000 });
    expect(edited.some(row => row.id === removed.id)).toBe(false);
    expect(shifts(edited)).toHaveLength(3);
    expect(rotation.project({ presences: [], sessions: [], teams: new Map(), now: 2000 })).toEqual([]);
    expect(ids(rotation.project({ ...input, now: 3000 }))).toEqual(ids(first));
    rotation.project({ ...input, now: 21 * 60_000 });
    rotation.reset();
    expect(ids(rotation.project({ ...input, now: 0 }))).toEqual(ids(first));
  });

  it('selects history IDs from current Native metadata before applying the enabled gate', () => {
    const older = session('older', 10, 'workspace');
    const newer = { ...session('newer', 10, 'workspace'), lastActiveAt: '2026-11-02T00:00:00.000Z' };
    const disabled = { ...newer, team: { enabled: false, size: 10 } };
    const hermes = { ...session('hermes'), runtime: { id: 'hermes' as const, profile: 'default' } };
    const observed = { ...session('observed'), control: 'observed' as const };
    expect(nativeStandbySessionIds([older, newer, hermes, observed])).toEqual(['newer']);
    expect(nativeStandbySessionIds([older, disabled])).toEqual([]);
    expect(nativeStandbySessionIds([{ ...older, running: true }, disabled])).toEqual(['older']);
  });

  it('does not revive an old Native crew after its workspace switches to Hermes, while Observe stays independent', () => {
    const older = session('older', 10, 'workspace');
    const newer = { ...session('newer', 10, 'workspace'), lastActiveAt: '2026-11-02T00:00:00.000Z' };
    const hermes = { ...newer, runtime: { id: 'hermes' as const, profile: 'default' } };
    expect(nativeStandbySessionIds([older, hermes])).toEqual([]);
    const input = fixture([older, hermes]);
    expect(shifts(new NativeStandbyRotation().project({ ...input, now: 0 }))).toHaveLength(0);
    const observed = { ...newer, control: 'observed' as const };
    expect(nativeStandbySessionIds([older, observed])).toEqual(['older']);
  });

  it('waits for current history without falling back to a loaded historic team', () => {
    const older = session('older', 10, 'workspace');
    const latest = { ...session('latest', 10, 'workspace'), lastActiveAt: '2026-11-02T00:00:00.000Z' };
    const input = fixture([older, latest]);
    const rotation = new NativeStandbyRotation();
    const before = rotation.project({ ...input, readySessionIds: new Set([older.id]), now: 0 });
    expect(before).toEqual(input.presences);
    expect(before.some(row => row.nativeStandby)).toBe(false);
    const error = worker(latest, 0, { status: 'offline', running: false, phase: 'error' });
    const after = rotation.project({ ...input, presences: [...input.presences, error], readySessionIds: new Set([latest.id]), now: 1000 });
    expect(shifts(after)).toHaveLength(3);
    expect(after.find(row => row.id === error.id)).toBe(error);
    const ended = input.presences.map(row => row.sessionId === latest.id ? { ...row, status: 'offline' as const } : row);
    const terminal = rotation.project({ ...input, presences: [...ended, error], readySessionIds: new Set([latest.id]), now: 2000 });
    expect(terminal.some(row => row.nativeStandby)).toBe(false);
    expect(terminal.find(row => row.id === error.id)).toBe(error);
  });

  it('preserves leases and fairness across an unready history gap', () => {
    const rotation = new NativeStandbyRotation();
    const input = fixture([session()]);
    const readySessionIds = new Set(['native']);
    const first = rotation.project({ ...input, readySessionIds, now: 0 });
    expect(rotation.project({ ...input, teams: new Map(), readySessionIds: new Set(), now: 1000 })).toEqual(input.presences);
    expect(ids(rotation.project({ ...input, readySessionIds, now: 2000 }))).toEqual(ids(first));
    rotation.project({ ...input, readySessionIds: new Set(), now: 21 * 60_000 });
    const rotated = rotation.project({ ...input, readySessionIds, now: 21 * 60_000 });
    expect(ids(rotated).every(id => !ids(first).includes(id))).toBe(true);
  });

  it('retains the global cap when preserved leases return after other teams hydrate', () => {
    const rotation = new NativeStandbyRotation();
    const input = fixture([session('first', 32), session('second', 32)]);
    expect(shifts(rotation.project({ ...input, readySessionIds: new Set(['first']), now: 0 }))).toHaveLength(5);
    expect(shifts(rotation.project({ ...input, readySessionIds: new Set(['second']), now: 1000 }))).toHaveLength(5);
    expect(shifts(rotation.project({ ...input, readySessionIds: new Set(['first', 'second']), now: 2000 }))).toHaveLength(5);
  });

  it('deduplicates malformed roster IDs and accepts its previous projection without duplicating rows', () => {
    const input = fixture([session()]);
    input.teams.set('native', [...roster(input.sessions[0]!), ...roster(input.sessions[0]!), { id: 'primary', name: 'Invalid lead' }]);
    const rotation = new NativeStandbyRotation();
    const first = rotation.project({ ...input, now: 0 });
    const second = rotation.project({ ...input, presences: first, now: 1000 });
    expect(new Set(second.map(row => row.id)).size).toBe(second.length);
    expect(second).toHaveLength(11);
    expect(ids(second)).toEqual(ids(first));
  });
});
