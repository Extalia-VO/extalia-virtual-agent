import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { BOARD_REORDER_MS, boardBranchActive, boardOrder, boardRows, boardTreeActive, boardTreeTone, nextBoardOrder, sameBoardIds, splitBoard, TREE_ELBOW_PATHS } from '../src/office/overlay/boardTree';
import { flipPlan, type FlipRecord } from '../src/office/overlay/boardMotion';

function agent(id: string, parentId?: string): OfficeAgent {
  return {
    id, sessionId: 's', agentId: id, displayName: id, control: 'managed', status: 'idle', running: false,
    ...(parentId ? { parentId } : {}),
  };
}

const ids = (rows: ReturnType<typeof boardRows>) => rows.map(row => `${row.agent.id}@${row.depth}`);

describe('boardRows', () => {
  it('lists each lead followed by its subagents, in board order', () => {
    const rows = boardRows([agent('lead'), agent('w1', 'lead'), agent('w2', 'lead'), agent('other')]);
    expect(ids(rows)).toEqual(['lead@0', 'w1@1', 'w2@1', 'other@0']);
    expect(rows[0]).toMatchObject({ descendants: 2, expanded: true });
    expect(rows[1]).toMatchObject({ descendants: 0 });
  });

  it('hides a collapsed lead subagents but keeps the count', () => {
    const rows = boardRows([agent('lead'), agent('w1', 'lead'), agent('w2', 'lead'), agent('other')], new Set(['lead']));
    expect(ids(rows)).toEqual(['lead@0', 'other@0']);
    expect(rows[0]).toMatchObject({ descendants: 2, expanded: false });
  });

  it('nests subagents of subagents one level deeper', () => {
    const rows = boardRows([agent('lead'), agent('w1', 'lead'), agent('deep', 'w1')]);
    expect(ids(rows)).toEqual(['lead@0', 'w1@1', 'deep@2']);
    expect(rows[0]?.descendants).toBe(2);
    expect(rows[1]?.descendants).toBe(1);
  });

  it('treats an agent with a missing parent as a lead so it stays on the board', () => {
    expect(ids(boardRows([agent('orphan', 'gone')]))).toEqual(['orphan@0']);
  });

  it('keeps every agent of a parent loop on the board', () => {
    const rows = boardRows([agent('a', 'b'), agent('b', 'a'), agent('c', 'a')]);
    expect(rows.map(row => row.agent.id).sort()).toEqual(['a', 'b', 'c']);
    expect(rows.every(row => row.depth >= 0)).toBe(true);
    expect(rows.filter(row => row.agent.id === 'a' || row.agent.id === 'b')).toHaveLength(2);
  });

  it('ignores a self-parent', () => {
    expect(ids(boardRows([agent('solo', 'solo')]))).toEqual(['solo@0']);
  });

  it('returns no rows for no agents', () => {
    expect(boardRows([])).toEqual([]);
  });
});

describe('team members on the board', () => {
  it('lists idle members of a lead team under it, once, without duplicating present ones', async () => {
    const { withTeamMembers, boardRows } = await import('../src/office/overlay/boardTree');
    const lead = { id: 's1:primary', sessionId: 's1', agentId: 'primary', displayName: 'Aria Ravelle', control: 'managed' as const, status: 'idle' as const, running: false };
    const present = { ...lead, id: 's1:m1', agentId: 'm1', displayName: 'Elena Mark', parentId: 's1:primary', status: 'working' as const, running: true };
    const teams = new Map([['s1', [{ id: 'm1', name: 'Elena Mark', gender: 'female' }, { id: 'm2', name: 'Kaelen Vael', gender: 'male' }]]]);
    const rows = boardRows(withTeamMembers([lead, present], teams));
    expect(rows.map(row => [row.agent.displayName, row.depth, row.agent.status])).toEqual([
      ['Aria Ravelle', 0, 'idle'], ['Elena Mark', 1, 'working'], ['Kaelen Vael', 1, 'offline'],
    ]);
    expect(rows[2]!.last).toBe(true);
  });
});

describe('board activity time (v0.0.38)', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const ago = (ms: number) => NOW - ms;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const JUST = 'just now';

  it('reads "just now" under 45 seconds, and in the translated just-now text', async () => {
    const { boardAgo } = await import('../src/office/overlay/boardTree');
    expect(boardAgo(ago(0), NOW, 'en', JUST)).toBe(JUST);
    expect(boardAgo(ago(44_000), NOW, 'en', JUST)).toBe(JUST);
    expect(boardAgo(NOW + 5_000, NOW, 'en', JUST)).toBe(JUST);
    expect(boardAgo(ago(30_000), NOW, 'id', 'baru saja')).toBe('baru saja');
  });

  it('words English minutes, hours, days, weeks and months with Intl', async () => {
    const { boardAgo } = await import('../src/office/overlay/boardTree');
    expect(boardAgo(ago(50_000), NOW, 'en', JUST)).toBe('1 minute ago');
    expect(boardAgo(ago(5 * MIN), NOW, 'en', JUST)).toBe('5 minutes ago');
    expect(boardAgo(ago(2 * HOUR + 10 * MIN), NOW, 'en', JUST)).toBe('2 hours ago');
    expect(boardAgo(ago(26 * HOUR), NOW, 'en', JUST)).toBe('yesterday');
    expect(boardAgo(ago(3 * 24 * HOUR), NOW, 'en', JUST)).toBe('3 days ago');
    expect(boardAgo(ago(15 * 24 * HOUR), NOW, 'en', JUST)).toBe('2 weeks ago');
    expect(boardAgo(ago(70 * 24 * HOUR), NOW, 'en', JUST)).toBe('2 months ago');
  });

  it('words Indonesian relative times in the same units, in the short form', async () => {
    const { boardAgo } = await import('../src/office/overlay/boardTree');
    expect(boardAgo(ago(5 * MIN), NOW, 'id', 'baru saja')).toBe('5 mnt lalu');
    expect(boardAgo(ago(26 * HOUR), NOW, 'id', 'baru saja')).toBe('kemarin');
    expect(boardAgo(ago(2 * HOUR), NOW, 'id', 'baru saja')).toBe('2 jam lalu');
  });

  it('gives the absolute time for the title, in the UI language', async () => {
    const { boardAbsolute } = await import('../src/office/overlay/boardTree');
    expect(boardAbsolute(NOW, 'en')).toMatch(/2026/);
    expect(boardAbsolute(NOW, 'id')).toMatch(/2026/);
  });

  it('takes a subagent its own newest event and ignores other agents', async () => {
    const { boardActivityAt } = await import('../src/office/overlay/boardTree');
    const worker = { id: 's1:w1', sessionId: 's1', agentId: 'w1', displayName: 'Elena', control: 'managed' as const, status: 'working' as const, running: true, parentId: 's1:primary' };
    const latest = new Map([
      ['s1:primary', { at: new Date(ago(10 * MIN)).toISOString(), sessionId: 's1' }],
      ['s1:w1', { at: new Date(ago(2 * MIN)).toISOString(), sessionId: 's1' }],
      ['s2:primary', { at: new Date(ago(MIN)).toISOString(), sessionId: 's2' }],
    ]);
    expect(boardActivityAt(worker, latest)).toBe(ago(2 * MIN));
    expect(boardActivityAt({ ...worker, id: 's1:w2', agentId: 'w2' }, latest)).toBeUndefined();
  });

  it('gives a lead the newest event of its session, including its subagents', async () => {
    const { boardActivityAt } = await import('../src/office/overlay/boardTree');
    const lead = { id: 's1:primary', sessionId: 's1', agentId: 'primary', displayName: 'Aria', control: 'managed' as const, status: 'working' as const, running: true };
    const latest = new Map([
      ['s1:primary', { at: new Date(ago(9 * MIN)).toISOString(), sessionId: 's1' }],
      ['s1:w1', { at: new Date(ago(3 * MIN)).toISOString(), sessionId: 's1' }],
      ['s2:primary', { at: new Date(ago(MIN)).toISOString(), sessionId: 's2' }],
    ]);
    expect(boardActivityAt(lead, latest)).toBe(ago(3 * MIN));
  });

  it('counts an observed lead reported lastActivityAt when it is newer', async () => {
    const { boardActivityAt } = await import('../src/office/overlay/boardTree');
    const observed = { id: 's1:primary', sessionId: 's1', agentId: 'primary', displayName: 'Claude', control: 'observed' as const, status: 'idle' as const, running: false, lastActivityAt: new Date(ago(4 * MIN)).toISOString() };
    expect(boardActivityAt(observed, new Map())).toBe(ago(4 * MIN));
    const newer = new Map([['s1:primary', { at: new Date(ago(MIN)).toISOString(), sessionId: 's1' }]]);
    expect(boardActivityAt(observed, newer)).toBe(ago(MIN));
  });

  it('has no time for an agent without any activity (offline team member)', async () => {
    const { boardActivityAt } = await import('../src/office/overlay/boardTree');
    const offline = { id: 's1:m2', sessionId: 's1', agentId: 'm2', displayName: 'Kaelen', control: 'managed' as const, status: 'offline' as const, running: false, parentId: 's1:primary' };
    expect(boardActivityAt(offline, new Map())).toBeUndefined();
  });
});

describe('board compact activity time (v0.0.38)', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const ago = (ms: number) => NOW - ms;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  it('reads "now" and "baru" under 45 seconds, and wording "2m", "25m", "3h", "1d" in EN', async () => {
    const { boardAgoShort } = await import('../src/office/overlay/boardTree');
    const { MESSAGES } = await import('../src/i18n');
    const en = MESSAGES.en.officeUx.composer.agoShort;
    expect(boardAgoShort(ago(20_000), NOW, en)).toBe('now');
    expect(boardAgoShort(ago(50_000), NOW, en)).toBe('1m');
    expect(boardAgoShort(ago(2 * MIN), NOW, en)).toBe('2m');
    expect(boardAgoShort(ago(25 * MIN), NOW, en)).toBe('25m');
    expect(boardAgoShort(ago(3 * HOUR + 5 * MIN), NOW, en)).toBe('3h');
    expect(boardAgoShort(ago(26 * HOUR), NOW, en)).toBe('1d');
    expect(boardAgoShort(ago(45 * 24 * HOUR), NOW, en)).toBe('45d');
  });
  it('uses the Indonesian compact wording "baru", "2 mnt", "3 jam", "1 hr"', async () => {
    const { boardAgoShort } = await import('../src/office/overlay/boardTree');
    const { MESSAGES } = await import('../src/i18n');
    const id = MESSAGES.id.officeUx.composer.agoShort;
    expect(boardAgoShort(ago(10_000), NOW, id)).toBe('baru');
    expect(boardAgoShort(ago(2 * MIN), NOW, id)).toBe('2 mnt');
    expect(boardAgoShort(ago(3 * HOUR), NOW, id)).toBe('3 jam');
    expect(boardAgoShort(ago(30 * HOUR), NOW, id)).toBe('1 hr');
  });
});

describe('board tree connectors (v0.0.48)', () => {
  const working = (id: string, parentId?: string): OfficeAgent => ({ ...agent(id, parentId), status: 'working' });
  const idle = (id: string, parentId?: string): OfficeAgent => ({ ...agent(id, parentId), status: 'idle' });

  it('colours a connector by the child status tone', () => {
    expect(boardTreeTone({ ...agent('a'), status: 'working' })).toBe('work');
    expect(boardTreeTone({ ...agent('a'), status: 'thinking' })).toBe('work');
    expect(boardTreeTone({ ...agent('a'), status: 'waiting' })).toBe('wait');
    expect(boardTreeTone({ ...agent('a'), status: 'working', pendingApprovalId: 'p1' })).toBe('wait');
    expect(boardTreeTone({ ...agent('a'), status: 'blocked' })).toBe('error');
    expect(boardTreeTone({ ...agent('a'), status: 'working', stalled: true })).toBe('warn');
    expect(boardTreeTone({ ...agent('a'), status: 'observing' })).toBe('observe');
    expect(boardTreeTone({ ...agent('a'), status: 'idle' })).toBe('idle');
  });

  it('marks a queued mission task as queued, not idle', () => {
    const queued = { ...idle('a'), mission: { state: 'queued' } } as unknown as OfficeAgent;
    expect(boardTreeTone(queued)).toBe('queued');
  });

  it('animates only children doing work now', () => {
    expect(boardTreeActive(working('a'))).toBe(true);
    expect(boardTreeActive({ ...idle('a'), phase: 'compacting' })).toBe(true);
    expect(boardTreeActive({ ...idle('a'), phase: 'planning' })).toBe(true);
    expect(boardTreeActive({ ...agent('a'), status: 'waiting' })).toBe(false);
    expect(boardTreeActive({ ...working('a'), stalled: true })).toBe(false);
    expect(boardTreeActive({ ...working('a'), status: 'offline' })).toBe(false);
    expect(boardTreeActive({ ...working('a'), pendingApprovalId: 'p1' })).toBe(false);
  });

  it('flows a lead trunk only when a nested child is active', () => {
    const quiet = boardRows([idle('lead'), idle('w1', 'lead'), idle('other')]);
    expect(boardBranchActive(quiet, 0)).toBe(false);
    const busy = boardRows([idle('lead'), idle('w1', 'lead'), working('w2', 'lead'), idle('other')]);
    expect(boardBranchActive(busy, 0)).toBe(true);
    expect(boardBranchActive(busy, 3)).toBe(false);
  });
});

describe('board order (v0.0.50)', () => {
  const activity = (times: Record<string, number>) => (agentId: OfficeAgent) => times[agentId.id];
  const ids = (list: readonly string[]) => list.join(',');

  it('lists leads newest first, by their own or any descendant activity', () => {
    // "old" has the oldest own activity, but its subagent is the newest of all, so the whole lead moves to the top.
    const agents = [agent('old'), agent('old-child', 'old'), agent('mid')];
    expect(ids(boardOrder(agents, activity({ old: 10, 'old-child': 90, mid: 50 })))).toBe('old,old-child,mid');
    expect(ids(boardOrder(agents, activity({ old: 10, 'old-child': 1, mid: 50 })))).toBe('mid,old,old-child');
  });

  it('orders each lead subagents newest first, and keeps them under their lead', () => {
    const agents = [agent('lead'), agent('w1', 'lead'), agent('w2', 'lead'), agent('w3', 'lead'), agent('other')];
    const order = boardOrder(agents, activity({ lead: 500, w1: 100, w2: 300, w3: 200, other: 400 }));
    expect(order).toEqual(['lead', 'w2', 'w3', 'w1', 'other']);
    const rows = boardRows(agents, new Set(), order);
    expect(rows.map(row => row.agent.id)).toEqual(['lead', 'w2', 'w3', 'w1', 'other']);
    expect(rows.find(row => row.agent.id === 'w1')).toMatchObject({ last: true, depth: 1 });
    expect(rows.find(row => row.agent.id === 'w2')).toMatchObject({ last: false, depth: 1 });
  });

  it('is stable for equal or missing times: input order decides, so nothing jitters', () => {
    const agents = [agent('b'), agent('a'), agent('c'), agent('d', 'a'), agent('e', 'a')];
    const same = activity({ a: 7, b: 7, c: 7, d: 7, e: 7 });
    expect(ids(boardOrder(agents, same))).toBe('b,a,d,e,c');
    expect(ids(boardOrder(agents, same))).toBe(ids(boardOrder(agents, same)));
    // No activity at all: the input order stands, and a dated agent always comes before an undated one.
    expect(ids(boardOrder([agent('x'), agent('y'), agent('z')], () => undefined))).toBe('x,y,z');
    expect(ids(boardOrder([agent('x'), agent('y')], activity({ y: 1 })))).toBe('y,x');
  });

  it('puts the Earlier groups last, newest first inside and between groups', () => {
    const earlierAgent = (id: string, sessionId: string, parentId?: string): OfficeAgent => ({ ...agent(id, parentId), sessionId, earlier: true });
    const present = [{ ...agent('lead'), sessionId: 'p' }, { ...agent('w', 'lead'), sessionId: 'p' }];
    const old1 = earlierAgent('old1', 'o1');
    const old2 = earlierAgent('old2', 'o2');
    const old2c = earlierAgent('old2c', 'o2', 'old2');
    const agents = [old1, ...present, old2, old2c];
    const times: Record<string, number> = { lead: 5, w: 6, old1: 100, old2: 200, old2c: 10 };
    const board = splitBoard(agents, new Set(), activity(times), boardOrder(agents, activity(times)));
    expect(board.present.map(row => row.agent.id)).toEqual(['lead', 'w']);
    expect(board.earlier.map(group => group.sessionId)).toEqual(['o2', 'o1']);
    expect(board.earlier[0]?.rows.map(row => row.agent.id)).toEqual(['old2', 'old2c']);
  });

  it('follows a settled order when given, so rows reorder only when the settled order does', () => {
    const agents = [{ ...agent('a'), sessionId: 's' }, { ...agent('b'), sessionId: 's' }];
    const board = splitBoard(agents, new Set(), undefined, ['b', 'a']);
    expect(board.present.map(row => row.agent.id)).toEqual(['b', 'a']);
  });
});

describe('settled board order (v0.0.50)', () => {
  it('holds a pure reorder while the cooldown runs, and shows the newest order once it ends', () => {
    const shown = ['a', 'b', 'c'];
    // Cooling: the reorder waits.
    expect(nextBoardOrder(shown, ['c', 'a', 'b'], true)).toEqual({ ids: shown, changed: false });
    // Cooldown over: the newest desired order lands.
    expect(nextBoardOrder(shown, ['b', 'c', 'a'], false)).toEqual({ ids: ['b', 'c', 'a'], changed: true });
    expect(BOARD_REORDER_MS).toBe(1000);
  });

  it('applies a change of who is listed at once, even during a cooldown', () => {
    expect(nextBoardOrder(['a', 'b'], ['c', 'a', 'b'], true)).toEqual({ ids: ['c', 'a', 'b'], changed: true });
    expect(nextBoardOrder(['a', 'b', 'c'], ['a', 'b'], true)).toEqual({ ids: ['a', 'b'], changed: true });
  });

  it('does nothing when the shown order is already the desired one', () => {
    const shown = ['a', 'b'];
    expect(nextBoardOrder(shown, ['a', 'b'], false).ids).toBe(shown);
    expect(nextBoardOrder(shown, ['a', 'b'], false).changed).toBe(false);
    expect(sameBoardIds(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('board flip plan (v0.0.50)', () => {
  const rows = (...list: [string, number, number][]) => new Map(list.map(([key, top, index]) => [key, { top, index } as FlipRecord]));
  it('plans a glide only for rows whose place changed and that moved', () => {
    // "b" overtakes "a": "b" was lower (top 40) and is now on top (top 0); "a" went down.
    const before = rows(['a', 0, 0], ['b', 40, 1], ['c', 80, 2]);
    const after = rows(['b', 0, 0], ['a', 40, 1], ['c', 80, 2]);
    expect(flipPlan(before, after)).toEqual([{ key: 'b', delta: 40 }, { key: 'a', delta: -40 }]);
  });

  it('ignores unchanged rows, new rows and sub-pixel moves', () => {
    const before = rows(['a', 0, 0], ['b', 40, 1]);
    const after = rows(['a', 0, 0], ['b', 40.4, 1], ['new', 80, 2]);
    expect(flipPlan(before, after)).toEqual([]);
  });

  it('exposes the connector paths: the last child keeps a round corner', () => {
    expect(TREE_ELBOW_PATHS.last).toMatch(/A6\.5 6\.5 0 0 0 7 26\.5/);
    expect(TREE_ELBOW_PATHS.branch).toMatch(/A7\.5 7\.5 0 0 0 8 26\.5/);
  });
});
