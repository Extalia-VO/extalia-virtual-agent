import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import {
  boardFromAgents, buildSurfaceSpec, hotSlotFor, intentForOccupant, MIN_LIVE_INTERVAL_MS, occupantFromAgent, phaseFor,
  resolveScreenContent, slotRole, surfaceGeometry, type ScreenOccupant, type ScreenRequest,
} from '../src/office/scene/interior/prefabs/screens/screenContent';

const occupant = (status: ScreenOccupant['status'], extra: Partial<ScreenOccupant> = {}): ScreenOccupant => ({ name: 'Agent', status, ...extra });
const request = (extra: Partial<ScreenRequest> = {}): ScreenRequest => ({ device: 'monitor', lightsOn: true, night: false, ...extra });
const resolve = (extra: Partial<ScreenRequest> = {}) => resolveScreenContent(request(extra));

describe('screen content per device slot', () => {
  const working = occupant('working', { activity: 'edit', target: 'src/example.ts' });

  it('gives each monitor of a multi-screen desk a different role', () => {
    expect([1, 2, 3].map(slot => slotRole(slot, 3))).toEqual(['editor', 'terminal', 'docs']);
    expect([1, 2].map(slot => slotRole(slot, 2))).toEqual(['editor', 'terminal']);
    expect(slotRole(1, 1)).toBe('editor');
    // While the agent edits, monitors 2 and 3 keep their own distinct, ambient content.
    const kinds = [1, 2, 3].map(slot => resolve({ slot, slots: 3, occupant: working }));
    expect(kinds.map(entry => entry.kind)).toEqual(['editor', 'terminal', 'docs']);
    expect(kinds.map(entry => entry.hot)).toEqual([true, false, false]);
  });

  it('moves the focus (animated, highlighted) screen to the slot that matches the activity', () => {
    const slots = (activity: ScreenOccupant['activity'], status: ScreenOccupant['status'] = 'working') =>
      [1, 2, 3].map(slot => resolve({ slot, slots: 3, occupant: occupant(status, activity ? { activity } : {}) }));
    expect(slots('command').map(entry => entry.hot)).toEqual([false, true, false]);
    expect(slots('test').map(entry => entry.kind)).toEqual(['editor', 'tests', 'docs']);
    expect(slots('search').map(entry => [entry.kind, entry.hot])).toEqual([['editor', false], ['terminal', false], ['docs', true]]);
    expect(slots('web')[2]).toMatchObject({ kind: 'docs', detail: 'web', hot: true });
    expect(slots('read')[2]).toMatchObject({ kind: 'docs', detail: 'read', hot: true });
    expect(slots(undefined, 'waiting').map(entry => [entry.kind, entry.hot])).toEqual([['approval', true], ['terminal', false], ['docs', false]]);
    // A two-screen desk has no third slot: documents go to monitor 2.
    expect(hotSlotFor('docs', 2)).toBe(2);
    expect(hotSlotFor('terminal', 1)).toBe(1);
    expect(hotSlotFor('approval', 3)).toBe(1);
  });

  it('shows one screen what the agent is doing, whatever the activity', () => {
    const single = (agent: ScreenOccupant) => resolve({ occupant: agent });
    expect(single(occupant('working', { activity: 'edit' }))).toMatchObject({ kind: 'editor', detail: 'edit', hot: true, mode: 'live' });
    expect(single(occupant('working', { activity: 'command' }))).toMatchObject({ kind: 'terminal', detail: 'command' });
    expect(single(occupant('working', { activity: 'tool' }))).toMatchObject({ kind: 'terminal' });
    expect(single(occupant('working', { activity: 'test' }))).toMatchObject({ kind: 'tests' });
    expect(single(occupant('working', { activity: 'knowledge' }))).toMatchObject({ kind: 'docs', detail: 'read' });
    expect(single(occupant('thinking'))).toMatchObject({ kind: 'editor', detail: 'think' });
    expect(single(occupant('working'))).toMatchObject({ kind: 'editor', detail: 'think' });
    expect(single(occupant('blocked'))).toMatchObject({ kind: 'editor', detail: 'blocked' });
    expect(single(occupant('delegating'))).toMatchObject({ kind: 'dashboard', detail: 'delegate' });
    expect(single(occupant('waiting', { activity: 'edit' }))).toMatchObject({ kind: 'approval' });
  });

  it('keeps device shells apart: monitor, all-in-one desktop and laptop', () => {
    const styles = (['monitor', 'all-in-one', 'laptop'] as const).map(device => resolve({ device, occupant: working }));
    expect(styles.map(entry => entry.style)).toEqual(['monitor', 'desktop', 'laptop']);
    const keys = styles.map(entry => buildSurfaceSpec(entry, surfaceGeometry(0.72, 0.43), { language: 'en', phase: 0 }).key);
    expect(new Set(keys).size).toBe(3);
    expect(resolve({ device: 'wall' }).style).toBe('wall');
    expect(resolve({ device: 'tv', variant: 'media' })).toMatchObject({ kind: 'media', mode: 'live' });
  });

  it('picks wall boards by variant and shows the office overview by default', () => {
    const wall = (variant?: ScreenRequest['variant']) => resolve({ device: 'wall', variant }).kind;
    expect(wall()).toBe('agents');
    expect(wall('status')).toBe('agents');
    expect(wall('presentation')).toBe('standby');
    expect(wall('monitoring')).toBe('monitoring');
    expect(wall('diagram')).toBe('diagram');
    expect(wall('knowledge')).toBe('docs');
    expect(wall('signage')).toBe('signage');
    expect(wall('media')).toBe('media');
  });

  it('shows a welcome screen at the front desk, the second monitor as a visitor guide', () => {
    expect(resolve({ variant: 'welcome', slot: 2 })).toMatchObject({ kind: 'welcome', detail: 'directory', mode: 'live' });
    expect(resolve({ variant: 'welcome' })).toMatchObject({ kind: 'welcome', detail: 'greeting' });
    // Unoccupied: welcome instead of the lock screen, and it stays lit at night.
    expect(resolve({ idleContent: 'welcome', lightsOn: false, night: true })).toMatchObject({ kind: 'welcome', mode: 'live' });
    // Occupied: the receptionist's own work wins.
    expect(resolve({ idleContent: 'welcome', occupant: working })).toMatchObject({ kind: 'editor' });
  });
});

describe('power state', () => {
  it('locks an idle or unattended workstation so its glow stays visible in the dark, and darkens only when offline or unpowered', () => {
    expect(resolve()).toMatchObject({ mode: 'locked', kind: 'lock' });
    expect(resolve({ night: true, lightsOn: true })).toMatchObject({ mode: 'locked', kind: 'lock' });
    expect(resolve({ night: false, lightsOn: false })).toMatchObject({ mode: 'locked' });
    expect(resolve({ night: true, lightsOn: false })).toMatchObject({ mode: 'locked', kind: 'lock' });
    expect(resolve({ occupant: occupant('offline'), night: true, lightsOn: false })).toMatchObject({ mode: 'off' });
    expect(resolve({ powered: false })).toMatchObject({ mode: 'off' });
  });

  it('shows a lock screen for a seated agent that is not working, keeping the dark-room glow', () => {
    for (const [status, label] of [['idle', 'IDLE'], ['observing', 'OBSERVING'], ['paused', 'PAUSED'], ['unavailable', 'UNAVAILABLE'], ['stopping', 'STOPPING']] as const) {
      expect(resolve({ occupant: occupant(status), night: true, lightsOn: false })).toMatchObject({ mode: 'locked', kind: 'lock', label, name: 'Agent' });
    }
  });

  it('keeps wall boards and TVs on in the dark', () => {
    expect(resolve({ device: 'wall', night: true, lightsOn: false }).mode).toBe('live');
    expect(resolve({ device: 'tv', variant: 'media', night: true, lightsOn: false }).mode).toBe('live');
  });
});

describe('truthful content', () => {
  it('shows a safe phrase for the work, never the raw target or summary', () => {
    const shown = resolve({ occupant: occupant('working', { activity: 'command', target: 'rm -rf /Users/someone/secret.txt', summary: 'Running the build' }) });
    expect(shown).toMatchObject({ phrase: 'command', name: 'Agent' });
    expect(shown).not.toHaveProperty('summary');
    expect(JSON.stringify(shown)).not.toContain('secret');
    const bare = resolve({ occupant: occupant('working', { activity: 'command' }) });
    expect(bare.phrase).toBe('command');
    expect(resolve({ occupant: occupant('working', { activity: 'command', target: 'pnpm test' }) }).phrase).toBe('test');
    expect(resolve({ occupant: occupant('waiting', { activity: 'command', target: 'rm -rf /' }) }).phrase).toBe('approval');
    expect(intentForOccupant(occupant('working', { activity: 'search', target: 'query' }))).toEqual({ kind: 'docs', detail: 'search' });
  });

  it('projects a presence without inventing fields', () => {
    const agent: OfficeAgent = { id: 'a', sessionId: 's', agentId: 'primary', displayName: 'Planner', control: 'managed', status: 'working', running: true };
    expect(occupantFromAgent(agent)).toEqual({ name: 'Planner', status: 'working' });
    expect(occupantFromAgent(undefined)).toBeUndefined();
    expect(occupantFromAgent({ ...agent, activity: 'edit', target: 'a.ts', summary: 'Editing a.ts' })).toEqual({
      name: 'Planner', status: 'working', activity: 'edit', target: 'a.ts', summary: 'Editing a.ts',
    });
  });

  it('builds the office overview from real presences only', () => {
    const agent = (id: string, status: OfficeAgent['status'], activity?: OfficeAgent['activity']): OfficeAgent =>
      ({ id, sessionId: id, agentId: 'primary', displayName: id, control: 'managed', status, running: true, ...(activity ? { activity } : {}) });
    const board = boardFromAgents([agent('b', 'working', 'edit'), agent('a', 'idle'), agent('c', 'offline'), agent('d', 'working', 'edit'), agent('e', 'thinking', 'search')]);
    expect(board.total).toBe(4);
    expect(board.statuses).toEqual({ working: 2, idle: 1, thinking: 1 });
    expect(board.activities).toEqual({ edit: 2, search: 1 });
    expect(board.top.map(entry => entry.name)).toEqual(['b', 'd', 'e', 'a']);
    expect(boardFromAgents([]).total).toBe(0);
  });
});

describe('live intervals', () => {
  it('never schedules a repaint faster than 2 Hz and animates ambient work screens smoothly', () => {
    const live = [resolve({ occupant: occupant('working', { activity: 'edit' }) }), resolve({ device: 'wall' }), resolve({ device: 'tv', variant: 'media' }),
      resolve({ occupant: occupant('waiting') })];
    for (const entry of live) {
      expect(entry.liveMs).toBeGreaterThanOrEqual(MIN_LIVE_INTERVAL_MS);
    }
    expect(resolve({ slot: 2, slots: 3, occupant: occupant('working', { activity: 'edit' }) }).liveMs).toBeGreaterThanOrEqual(MIN_LIVE_INTERVAL_MS);
    expect(resolve({ occupant: occupant('idle') }).liveMs).toBeGreaterThanOrEqual(MIN_LIVE_INTERVAL_MS);
  });
});

describe('reduced motion', () => {
  it('stops animated content and keeps only clocks ticking', () => {
    const still = (extra: Partial<ScreenRequest>) => resolve({ ...extra, reducedMotion: true });
    expect(still({ occupant: occupant('working', { activity: 'edit' }) })).toMatchObject({ kind: 'editor', hot: true, liveMs: 0 });
    expect(still({ device: 'tv', variant: 'media' }).liveMs).toBe(0);
    expect(still({ device: 'wall', variant: 'monitoring' }).liveMs).toBe(0);
    expect(still({ occupant: occupant('waiting') }).liveMs).toBe(0);
    expect(still({}).liveMs).toBe(15_000);
    expect(still({ device: 'wall' }).liveMs).toBe(15_000);
    // The picture itself is unchanged: only the repaint schedule differs.
    expect(still({ occupant: occupant('working', { activity: 'edit' }) }).kind).toBe(resolve({ occupant: occupant('working', { activity: 'edit' }) }).kind);
  });
});

describe('surface specification and cache key', () => {
  const edit = resolve({ occupant: occupant('working', { activity: 'edit', target: 'a.ts' }) });
  const geometry = surfaceGeometry(0.72, 0.43);
  const key = (inputs: Partial<Parameters<typeof buildSurfaceSpec>[2]> = {}, resolved = edit, geo = geometry) =>
    buildSurfaceSpec(resolved, geo, { language: 'en', phase: 0, ...inputs }).key;

  it('shares one key between screens that look identical', () => {
    expect(key()).toBe(key());
    expect(key({ phase: 0 })).toBe(key({ phase: 4 }));
  });

  it('separates everything that changes pixels', () => {
    const keys = new Set([
      key(), key({ language: 'id' }), key({ phase: 1 }),
      key({}, resolve({ occupant: occupant('working', { activity: 'command', target: 'git status' }) })),
      key({}, resolve({ occupant: occupant('working', { activity: 'command', target: 'a.ts' }) })),
      key({}, edit, surfaceGeometry(2.8, 1.55)),
      key({}, resolve({ device: 'laptop', occupant: occupant('working', { activity: 'edit', target: 'a.ts' }) }), surfaceGeometry(0.48, 0.29)),
    ]);
    expect(keys.size).toBe(7);
  });

  it('ignores per-seat phase for screens that do not animate by phase, and board data for other kinds', () => {
    const standby = resolve({ device: 'wall', variant: 'presentation' });
    expect(key({ phase: 0 }, standby)).toBe(key({ phase: 3 }, standby));
    const lock = resolve();
    const board = boardFromAgents([]);
    expect(key({ board }, lock)).toBe(key({}, lock));
    const wall = resolve({ device: 'wall' });
    const busy = boardFromAgents([{ id: 'a', sessionId: 'a', agentId: 'primary', displayName: 'A', control: 'managed', status: 'working', running: true }]);
    expect(key({ board: busy }, wall)).not.toBe(key({ board }, wall));
  });

  it('derives canvas size from the panel aspect ratio', () => {
    expect(surfaceGeometry(0.72, 0.43)).toMatchObject({ pixelWidth: 512, designHeight: 608 });
    expect(surfaceGeometry(6.4, 2.0).designHeight).toBe(320);
    expect(surfaceGeometry(2.8, 1.55)).toMatchObject({ pixelWidth: 1024, designHeight: 560 });
    expect(phaseFor('seat-a')).toBe(phaseFor('seat-a'));
    expect(phaseFor(undefined)).toBe(0);
    for (const id of ['a', 'b', 'engineering.pod-a.seat-se', 'x'.repeat(40)]) expect([0, 1, 2, 3]).toContain(phaseFor(id));
  });
});
