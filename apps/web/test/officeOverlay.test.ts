import { CHARACTER_HAIR_STYLES } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import type { OfficeActivity } from '../src/office/activityFeed';
import type { OfficeAgent } from '../src/office/presence';
import { BOARD_LIMIT, boardActivities, formatAgo, timeAgo } from '../src/office/overlay/activityBoard';
import { AgentPortrait } from '../src/office/overlay/AgentPortrait';
import { activityBucket, failedTurnsSince, officeKpis } from '../src/office/overlay/kpis';
import { leadAgents } from '../src/office/overlay/leadBar';
import { agentsWaitingForDesk } from '../src/office/overlay/lobby';
import { buildOverlayModel } from '../src/office/overlay/model';
import { PORTRAIT_HAIR_PATHS, portraitHairShape, portraitModel } from '../src/office/overlay/portrait';
import { groupRooms, overlayRooms, roomView } from '../src/office/overlay/rooms';
import { isSearchShortcut, matchScore, moveActive, searchOffice } from '../src/office/overlay/search';
import { buildSearchSource } from '../src/office/overlay/searchSource';
import { statusTone } from '../src/office/overlay/status';
import { roomFocusZoom, CHARACTER_FOCUS_ZOOM } from '../src/office/scene/cameraFocus';
import { defaultCharacterAppearance } from '../src/office/scene/avatars/appearance';
import { OFFICE_ROOMS } from '../src/office/scene/interior/worldRegistry';

const agent = (id: string, patch: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id, sessionId: id.split(':')[0]!, agentId: id.split(':')[1] ?? 'primary', displayName: id, control: 'managed', status: 'idle', running: false, ...patch,
});
const activity = (id: string, characterId: string, at: string, kind: OfficeActivity['kind'] = 'tool', text = id): OfficeActivity =>
  ({ id, characterId, sessionId: characterId.split(':')[0]!, kind, text, at });
const failed = (id: string, at: string): ExtaliaEvent =>
  ({ id, sessionId: 's1', at, source: { runtime: 'test', channel: 'stream' }, body: { type: 'turn.failed', error: 'x' } }) as ExtaliaEvent;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('office search', () => {
  it('matches every word, accent-insensitively, and ranks name matches first', () => {
    expect(matchScore('', 'Alpha')).toBe(0);
    expect(matchScore('café', 'Cafe garden')).toBeGreaterThan(0);
    expect(matchScore('fix bug', 'Fix the login bug')).toBeGreaterThan(0);
    expect(matchScore('zzz', 'Fix bug')).toBe(0);
    expect(matchScore('fix', 'Fix bug')).toBeGreaterThan(matchScore('bug', 'Fix bug'));
    expect(matchScore('work', 'Alpha', ['Working…'])).toBeGreaterThan(0);
  });

  const t = MESSAGES.en;
  const rooms = overlayRooms(t.officeOverlay.rooms.names);
  const presences = [agent('s1:primary', { displayName: 'Refactor billing', status: 'working', running: true, activity: 'edit' }), agent('s2:primary', { displayName: 'Docs pass' })];
  const projects = new Map([['s1:primary', 'Billing app']]);
  const board = [activity('e1', 's1:primary', ago(1000), 'tool', 'Editing invoice.ts')];
  const source = buildSearchSource(t, { presences, projects, rooms, board, names: new Map(presences.map(a => [a.id, a.displayName])) });

  it('finds agents by name, status and project, rooms by name and floor, and recent activity', () => {
    expect(searchOffice('billing', source).filter(hit => hit.kind === 'agent').map(hit => hit.id)).toEqual(['s1:primary']);
    expect(searchOffice('working', source)[0]).toMatchObject({ kind: 'agent', id: 's1:primary' });
    expect(searchOffice('meeting', source).filter(hit => hit.kind === 'room').map(hit => hit.id)).toEqual(['meeting-a', 'meeting-b']);
    expect(searchOffice('floor 3 lab', source).map(hit => hit.id)).toContain('multi-engine');
    // Activity hits show the safe phrase, never the raw file name.
    const hit = searchOffice('working', source).find(entry => entry.kind === 'activity' && entry.item.characterId === 's1:primary');
    expect(hit?.kind === 'activity' ? hit.item.text : undefined).toBe('Working…');
    expect(searchOffice('invoice', source).some(entry => entry.kind === 'activity')).toBe(false);
    expect(searchOffice('   ', source)).toEqual([]);
    expect(searchOffice('qqqq', source)).toEqual([]);
  });

  it('matches English room names under Indonesian and groups results agents, rooms, activity', () => {
    const id = MESSAGES.id;
    const idSource = buildSearchSource(id, { presences, projects, rooms: overlayRooms(id.officeOverlay.rooms.names), board, names: new Map() });
    expect(searchOffice('lobi', idSource)[0]).toMatchObject({ kind: 'room', id: 'lobby' });
    expect(searchOffice('lobby', idSource)[0]).toMatchObject({ kind: 'room', id: 'lobby' });
    const kinds = searchOffice('e', source).map(hit => hit.kind);
    expect([...kinds]).toEqual([...kinds].sort((a, b) => ['agent', 'room', 'activity'].indexOf(a) - ['agent', 'room', 'activity'].indexOf(b)));
  });

  it('focuses on "/" only when not typing and no dialog or modifier is involved', () => {
    const key = (patch: object = {}) => ({ key: '/', altKey: false, ctrlKey: false, metaKey: false, target: { tagName: 'DIV' }, ...patch });
    expect(isSearchShortcut(key(), false)).toBe(true);
    expect(isSearchShortcut(key({ target: { tagName: 'INPUT' } }), false)).toBe(false);
    expect(isSearchShortcut(key({ target: { tagName: 'DIV', isContentEditable: true } }), false)).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key(), true)).toBe(false);
    expect(isSearchShortcut(key({ key: 'a' }), false)).toBe(false);
  });

  it('wraps the active result around', () => {
    expect(moveActive(0, 1, 3)).toBe(1);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(5, 1, 0)).toBe(0);
  });
});

describe('office rooms', () => {
  it('has an English and an Indonesian name for every room in the registry', () => {
    for (const language of ['en', 'id'] as const) {
      const names = MESSAGES[language].officeOverlay.rooms.names;
      expect(OFFICE_ROOMS.filter(room => !names[room.id]).map(room => room.id), language).toEqual([]);
    }
  });
  it('groups indoor rooms by floor, then the outdoor campus, and picks the matching view', () => {
    const groups = groupRooms(overlayRooms(MESSAGES.en.officeOverlay.rooms.names));
    expect(groups.map(group => group.key)).toEqual(['floor-1', 'floor-2', 'floor-3', 'outdoor']);
    expect(groups[0]!.rooms.every(room => !room.outdoor && room.floor === 1)).toBe(true);
    expect(groups[3]!.rooms.every(room => room.outdoor)).toBe(true);
    const lobby = overlayRooms({}).find(room => room.id === 'lobby')!;
    expect(lobby.label).toBe(lobby.registryLabel);
    expect(roomView(lobby)).toBe(1);
    expect(roomView(overlayRooms({}).find(room => room.outdoor)!)).toBe('campus');
    expect(overlayRooms({}).find(room => room.id === 'fitness')!.point[1]).toBeCloseTo(12.8);
  });
  it('zooms out for large rooms and never closer than a character view', () => {
    expect(roomFocusZoom([46, 6], 1200)).toBeLessThan(roomFocusZoom([8, 7], 1200));
    expect(roomFocusZoom([2, 2], 1200)).toBe(CHARACTER_FOCUS_ZOOM);
    expect(roomFocusZoom([200, 200], 390)).toBeGreaterThanOrEqual(8);
  });
});

describe('office counters', () => {
  it('derives each counter from presence and events', () => {
    const presences = [
      agent('a:primary', { status: 'working', running: true }),
      agent('a:w1', { status: 'working', running: true, parentId: 'a:primary' }),
      agent('b:primary', { status: 'waiting', running: true, pendingApprovalId: 'x' }),
      agent('c:primary', { status: 'idle' }),
      agent('d:primary', { status: 'observing', control: 'observed' }),
    ];
    const events = [failed('f1', ago(10 * 60_000)), failed('f2', ago(2 * 3600_000))];
    expect(officeKpis(presences, events, NOW)).toEqual({ running: 2, waiting: 1, working: 2, errors: 0, observed: 1, idle: 2 });
  });
  it('v0.0.38: counts every present agent (leads and subagents, managed and observed) in exactly one bucket', () => {
    const presences = [
      // Observed Codex lead working live, with a working subagent and a finished one: one running session, three observed agents.
      agent('o:primary', { control: 'observed', status: 'working', running: true, live: true, activity: 'edit' }),
      agent('o:w1', { control: 'observed', status: 'thinking', running: true, live: true, parentId: 'o:primary' }),
      agent('o:w2', { control: 'observed', status: 'idle', parentId: 'o:primary' }),
      agent('o:gone', { control: 'observed', status: 'offline', parentId: 'o:primary' }),
      // Observed lead asking the user a question (live): waiting, and its turn is in progress.
      agent('q:primary', { control: 'observed', status: 'waiting', phase: 'input', live: true }),
      // Managed lead whose last turn failed; managed lead ready.
      agent('m:primary', { status: 'idle', phase: 'error' }),
      agent('r:primary', { status: 'idle' }),
    ];
    const kpis = officeKpis(presences, [], NOW);
    expect(kpis).toEqual({ running: 2, working: 2, waiting: 1, errors: 1, idle: 2, observed: 4 });
    const present = presences.filter(item => item.status !== 'offline').length;
    expect(kpis.working + kpis.waiting + kpis.errors + kpis.idle).toBe(present);
    expect(activityBucket({ status: 'delegating' })).toBe('working');
    expect(activityBucket({ status: 'idle', pendingApprovalId: 'x' })).toBe('waiting');
    expect(activityBucket({ status: 'unavailable' })).toBe('errors');
    expect(activityBucket({ status: 'observing' })).toBe('idle');
  });
  it('counts failed turns in the last hour once, ignoring imported history', () => {
    const imported = { ...failed('f3', ago(1000)), source: { runtime: 'x', channel: 'import' } } as ExtaliaEvent;
    expect(failedTurnsSince([failed('f1', ago(1000)), failed('f1', ago(1000)), imported], NOW)).toBe(1);
    expect(failedTurnsSince([failed('f1', ago(3600_000 + 1))], NOW)).toBe(0);
  });
});

describe('activity board', () => {
  it('merges sources newest first, once per id, for characters in the office, up to the limit', () => {
    const known = new Set(['a:primary']);
    const live = [activity('2', 'a:primary', ago(1000)), activity('1', 'a:primary', ago(5000)), activity('x', 'gone:primary', ago(10))];
    const history = [activity('2', 'a:primary', ago(1000)), activity('0', 'a:primary', ago(9000))];
    expect(boardActivities([history, live], known).map(item => item.id)).toEqual(['2', '1', '0']);
    const many = Array.from({ length: 80 }, (_, index) => activity(`m${index}`, 'a:primary', ago(index * 1000)));
    expect(boardActivities([many], known)).toHaveLength(BOARD_LIMIT);
  });
  it('words relative times in both languages', () => {
    expect(timeAgo(ago(2000), NOW)).toEqual({ unit: 'now', value: 0 });
    expect(timeAgo(ago(42_000), NOW)).toEqual({ unit: 'seconds', value: 42 });
    expect(timeAgo(ago(5 * 60_000), NOW)).toEqual({ unit: 'minutes', value: 5 });
    expect(timeAgo(ago(3 * 3600_000), NOW)).toEqual({ unit: 'hours', value: 3 });
    expect(timeAgo(ago(49 * 3600_000), NOW)).toEqual({ unit: 'days', value: 2 });
    expect(formatAgo(MESSAGES.en.officeOverlay.ago, { unit: 'minutes', value: 5 })).toBe('5 min ago');
    expect(formatAgo(MESSAGES.id.officeOverlay.ago, { unit: 'minutes', value: 5 })).toBe('5 mnt lalu');
  });
});

describe('lead agents and full office', () => {
  it('shows lead characters needing attention first and counts the rest', () => {
    const presences = [
      agent('a:primary'), agent('b:primary', { status: 'working', running: true }), agent('c:primary', { status: 'waiting', pendingApprovalId: 'p' }),
      agent('a:w', { status: 'working' , parentId: 'a:primary' }), agent('d:primary', { status: 'offline' }), agent('e:primary'), agent('f:primary'),
    ];
    const { shown, more } = leadAgents(presences, 3);
    expect(shown.map(item => item.id)).toEqual(['c:primary', 'b:primary', 'a:primary']);
    expect(more).toBe(2);
  });
  it('lists present characters without a desk and nobody else', () => {
    const seat = (agentId: string) => ({ agentId, resourceId: agentId, id: agentId, floor: 1 as const, position: [0, 0, 0] as [number, number, number], rotationY: 0, seatHeight: 0.5 });
    const presences = [agent('a:primary'), agent('b:primary'), agent('c:primary', { status: 'offline' })];
    expect(agentsWaitingForDesk(presences, [seat('a:primary')]).map(item => item.id)).toEqual(['b:primary']);
    const model = buildOverlayModel({ presences, allocations: [seat('a:primary')], events: [], recent: [], now: NOW });
    expect(model.waitingForDesk).toHaveLength(1);
  });
  it('tones follow reported status', () => {
    expect(statusTone({ status: 'thinking' })).toBe('work');
    expect(statusTone({ status: 'idle', pendingApprovalId: 'x' })).toBe('wait');
    expect(statusTone({ status: 'observing' })).toBe('observe');
    expect(statusTone({ status: 'unavailable' })).toBe('error');
  });
});

describe('agent portrait', () => {
  it('has a silhouette for every hair style', () => {
    for (const style of CHARACTER_HAIR_STYLES) expect(PORTRAIT_HAIR_PATHS[portraitHairShape(style)], style).toBeTruthy();
  });
  it('uses the saved look, or the look generated from the id', () => {
    const generated = defaultCharacterAppearance('s1:primary');
    expect(portraitModel('s1:primary')).toMatchObject({ skin: generated.skinTone, hair: generated.hairColor });
    const saved = { ...generated, skinTone: '#112233', hairColor: '#445566', hairStyle: 'afro' as const, topColor: '#778899', accessories: { ...generated.accessories, glasses: 'round' as const } };
    const model = portraitModel('s1:primary', saved);
    expect(model).toMatchObject({ skin: '#112233', hair: '#445566', hairShape: 'afro', glasses: 'round' });
    const html = renderToStaticMarkup(createElement(AgentPortrait, { characterId: 's1:primary', appearance: saved }));
    expect(html).toContain('#112233');
    expect(html).toContain('<circle cx="18.5" cy="20.8" r="2.5"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('overlay strings', () => {
  const shape = (value: unknown): unknown => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value;
  it('has the same keys in English and Indonesian', () => {
    expect(shape(MESSAGES.id.officeOverlay)).toEqual(shape(MESSAGES.en.officeOverlay));
    expect(MESSAGES.en.officeOverlay.full.title(3)).toBe('Office full — 3 waiting');
    expect(MESSAGES.id.officeOverlay.full.title(3)).toBe('Kantor penuh — 3 menunggu');
  });
});
