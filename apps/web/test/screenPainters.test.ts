import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSurfaceSpec, resolveScreenContent, surfaceGeometry, type ScreenKind, type ScreenRequest } from '../src/office/scene/interior/prefabs/screens/screenContent';
import { paintScreen, wallpaperIndex } from '../src/office/scene/interior/prefabs/screens/screenPainters';

/** A recording 2D context: enough surface for the painters, no canvas needed. */
function fakeContext() {
  const strings: string[] = [];
  let fills = 0;
  const gradient = { addColorStop: () => undefined };
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (value: string) => ({ width: value.length * 9 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'fillText') return (value: string) => { strings.push(value); };
      if (prop === 'fillRect' || prop === 'fill') return () => { fills++; };
      return () => undefined;
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strings, fills: () => fills };
}

const paint = (request: ScreenRequest & { w?: number; h?: number; title?: string }, frame = 3) => {
  const { w = 0.72, h = 0.43, title, ...rest } = request;
  const spec = buildSurfaceSpec(resolveScreenContent(rest), surfaceGeometry(w, h), { language: 'en', phase: 1, title });
  const recorder = fakeContext();
  paintScreen(recorder.ctx, spec, frame, NOW, text => text);
  return { ...recorder, spec };
};
const NOW = Date.UTC(2026, 0, 1, 9, 30);
const clock = (now: number) => `${String(new Date(now).getHours()).padStart(2, '0')}:${String(new Date(now).getMinutes()).padStart(2, '0')}`;
const base: ScreenRequest = { device: 'monitor', lightsOn: true, night: false };
const worker = (activity?: 'edit' | 'command' | 'test' | 'search' | 'read' | 'web' | 'delegate', target?: string, status: 'working' | 'waiting' | 'thinking' | 'idle' = 'working') =>
  ({ name: 'Agent', status, ...(activity ? { activity } : {}), ...(target ? { target } : {}) });

describe('screen painters', () => {
  const globals = globalThis as unknown as { Path2D?: unknown };
  let previous: unknown;
  beforeEach(() => { previous = globals.Path2D; globals.Path2D = class { constructor(public path?: string) {} }; });
  afterEach(() => { globals.Path2D = previous; });

  it('paints every content kind on every device without error', () => {
    const kinds = new Set<ScreenKind>();
    const requests: ScreenRequest[] = [];
    for (const device of ['monitor', 'all-in-one', 'laptop'] as const) {
      for (const occupant of [worker('edit', 'a.ts'), worker('command', 'pnpm build'), worker('test', 'pnpm test'), worker('search', 'query'), worker('read', 'a.md'),
        worker('web', 'https://example.com'), worker('delegate'), worker(undefined, undefined, 'waiting'), worker(undefined, undefined, 'thinking'), worker(undefined, undefined, 'idle')]) {
        requests.push({ ...base, device, occupant });
      }
      requests.push({ ...base, device }, { ...base, device, slot: 2, slots: 3, occupant: worker('edit') },
        { ...base, device, slot: 2, slots: 3 }, { ...base, device, slot: 3, slots: 3 },
        { ...base, device, night: true, lightsOn: false, occupant: { name: 'Agent', status: 'offline' } });
    }
    for (const variant of [undefined, 'presentation', 'media', 'monitoring', 'diagram', 'knowledge', 'signage'] as const) {
      requests.push({ ...base, device: 'wall', variant });
    }
    requests.push({ ...base, variant: 'welcome' }, { ...base, variant: 'welcome', slot: 2 });
    for (const request of requests) {
      for (const frame of [0, 1, 7]) {
        const painted = paint({ ...request, w: request.device === 'wall' ? 2.8 : request.device === 'laptop' ? 0.48 : 0.72, h: request.device === 'wall' ? 1.55 : 0.43, title: 'Room' }, frame);
        kinds.add(painted.spec.kind);
        if (painted.spec.kind !== 'off') expect(painted.fills()).toBeGreaterThan(2);
      }
    }
    expect([...kinds].sort()).toEqual(['agents', 'approval', 'dashboard', 'diagram', 'docs', 'editor', 'lock', 'media', 'monitoring', 'off', 'signage', 'standby', 'terminal', 'tests', 'welcome']);
  });

  it('paints a dark screen as nothing but black glass', () => {
    const dark = paint({ ...base, night: true, lightsOn: false, occupant: { name: 'Agent', status: 'offline' } });
    expect(dark.spec.mode).toBe('off');
    expect(dark.strings).toEqual([]);
  });

  it('shows a safe phrase for the work, never the raw command, path, URL or query', () => {
    const command = paint({ ...base, occupant: worker('command', 'pnpm build --watch') });
    expect(command.strings).toContain('Running a command…');
    expect(command.strings.some(text => text.includes('pnpm') || text.includes('build'))).toBe(false);
    const test = paint({ ...base, occupant: worker('command', 'pnpm test') });
    expect(test.strings).toContain('Running tests…');
    const editor = paint({ ...base, occupant: worker('edit', '/Users/someone/src/example/thing.ts') });
    expect(editor.strings).toContain('Editing code…');
    expect(editor.strings.some(text => text.includes('thing.ts') || text.includes('someone'))).toBe(false);
    const anonymous = paint({ ...base, occupant: worker('edit') });
    expect(anonymous.strings).toContain('Editing code…');
    expect(anonymous.strings.filter(text => /\w+\.(tsx?|jsx?|md|json|py|rs|go)\b/.test(text))).toEqual([]);
    const browser = paint({ ...base, occupant: worker('web', 'https://example.com/page?token=abc') });
    expect(browser.strings).toContain('Researching…');
    expect(browser.strings.some(text => text.includes('example.com') || text.includes('token'))).toBe(false);
    const search = paint({ ...base, occupant: worker('search', 'how to do a thing') });
    expect(search.strings).toContain('Searching files…');
    expect(search.strings.some(text => text.includes('how to'))).toBe(false);
  });

  it('shows no pass/fail results or figures on test runs and dashboards', () => {
    const tests = paint({ ...base, occupant: worker('test') });
    expect(tests.strings.some(text => /pass|fail|✓|✗|\d+\s*(ms|%)/i.test(text))).toBe(false);
    const dashboard = paint({ ...base, occupant: worker('delegate') });
    expect(dashboard.strings.some(text => /\d/.test(text))).toBe(false);
  });

  it('shows that an approval is waiting, never the reported request text', () => {
    const approval = paint({ ...base, occupant: { name: 'Agent', status: 'waiting', summary: 'Run a command that changes files' } });
    expect(approval.strings.join(' ')).toContain('Approval requested');
    expect(approval.strings).toContain('Waiting for approval…');
    expect(approval.strings.some(text => text.includes('Run a command'))).toBe(false);
    expect(approval.strings).toContain('Allow');
    expect(approval.strings).toContain('Deny');
  });

  it('advances the changing line with the repaint counter', () => {
    const at = (frame: number) => paint({ ...base, occupant: worker('edit', 'a.ts') }, frame).strings.find(text => text.startsWith('Ln '));
    expect(at(1)).not.toBe(at(2));
    expect(at(2)).toBe(at(2));
  });

  it('lets laptops, desktops and bare monitors look different', () => {
    const run = (device: ScreenRequest['device']) => paint({ ...base, device, w: device === 'laptop' ? 0.48 : 0.72, occupant: worker('edit', 'a.ts') });
    expect(run('laptop').strings).not.toEqual(run('monitor').strings);
    // The desktop shell draws its taskbar clock; a bare monitor and a laptop's menu bar differ from it.
    expect(run('all-in-one').strings).toContain(clock(NOW));
    expect(run('monitor').strings).not.toContain(clock(NOW));
  });

  it('paints the displays of an idle desk differently: lock prompt, screensaver and clock', () => {
    const at = (slot: number) => paint({ ...base, slot, slots: 3, occupant: { name: 'Agent', status: 'idle' } });
    const [lock, saver, clockSaver] = [at(1), at(2), at(3)];
    expect(lock.spec.detail).toBe('idle');
    expect(lock.strings).toContain('Agent');
    expect(saver.spec.detail).toBe('screensaver');
    expect(saver.strings).not.toContain('Agent');
    expect(clockSaver.spec.detail).toBe('clock');
    expect(new Set([lock.strings.join('|'), saver.strings.join('|'), clockSaver.strings.join('|')]).size).toBe(3);
    // The screensaver keeps moving: the frame changes what is painted.
    const fills = (frame: number) => paint({ ...base, slot: 2, slots: 2 }, frame).fills();
    expect(fills(1)).toBeGreaterThan(10);
  });

  it('picks a different wallpaper per seat phase and per device on the same seat', () => {
    expect(new Set([0, 1, 2, 3].map(phase => wallpaperIndex('monitor', phase))).size).toBe(4);
    for (const phase of [0, 1, 2, 3]) {
      expect(wallpaperIndex('laptop', phase)).not.toBe(wallpaperIndex('monitor', phase));
      expect(wallpaperIndex('desktop', phase)).not.toBe(wallpaperIndex('laptop', phase));
    }
  });
});
