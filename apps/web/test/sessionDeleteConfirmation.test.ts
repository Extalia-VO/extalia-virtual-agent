import type { SessionSummary } from '@extalia/platform';
import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from '../src/chat/SessionList';
import { DeleteConfirmation } from '../src/ui/DeleteConfirmation';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ index: 0, states: [] as unknown[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value; }];
  },
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.states[index] ??= { current: initial }; },
}));
const nodes = (value: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : [];
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(language: 'en' | 'id' = 'en', observed = false) {
  const t = MESSAGES[language], onDelete = vi.fn(async (): Promise<void> => undefined);
  const session = { id: 'session-a', title: 'Example conversation', control: observed ? 'observed' : 'managed', workspaceId: 'workspace-a', connectionId: 'connection-a', createdAt: '2026-11-13T00:00:00Z', lastActiveAt: '2026-11-13T00:00:00Z', running: false } satisfies SessionSummary;
  const list = SessionList({ t, language, sessions: [session], activeId: session.id, onDelete, onSelect: vi.fn(), onRename: vi.fn(async () => undefined) });
  const row = nodes(list).find(node => typeof node.type === 'function')!;
  hooks.states = []; hooks.index = 0;
  const draw = () => { hooks.index = 0; return nodes((row.type as (props: unknown) => ReactNode)(row.props)); };
  const open = () => { const button = draw().find(node => node.type === 'button' && node.props['aria-label'] === `${t.common.delete}: ${session.title}`)!; (button.props.onClick as () => void)(); };
  const dialog = () => draw().find(node => node.type === DeleteConfirmation)!;
  return { t, draw, open, dialog, onDelete };
}
beforeEach(() => { hooks.states = []; hooks.index = 0; });
describe('explicit session deletion decision', () => {
  it.each(['en', 'id'] as const)('opens a named confirmation without deleting and cancel preserves the session (%s)', language => {
    const h = fixture(language); h.open();
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.dialog().props).toMatchObject({ title: h.t.deletion.sessionTitle, target: 'Example conversation', description: h.t.chat.deleteConfirm });
    expect(h.draw().some(node => node.type === 'button' && node.props['aria-label'] === `${h.t.common.delete}: Example conversation`)).toBe(true);
    (h.dialog().props.onCancel as () => void)();
    expect(h.dialog()).toBeUndefined(); expect(h.onDelete).not.toHaveBeenCalled();
  });
  it('states the source-data boundary for Observe sessions', () => {
    const h = fixture('en', true); h.open(); expect(h.dialog().props.description).toBe(h.t.deletion.observedDescription);
  });
  it('admits one explicitly confirmed deletion while the request is pending', async () => {
    const h = fixture(); let resolve!: () => void;
    h.onDelete.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; })); h.open();
    const confirm = h.dialog().props.onConfirm as () => void; confirm(); confirm(); await settle();
    expect(h.onDelete).toHaveBeenCalledExactlyOnceWith('session-a'); expect(h.dialog().props.busy).toBe(true);
    resolve(); await settle(); expect(h.dialog()).toBeUndefined();
  });
  it('keeps failed deletion visible and permits an explicit retry', async () => {
    const h = fixture(); h.onDelete.mockRejectedValueOnce(new Error('unavailable')); h.open();
    (h.dialog().props.onConfirm as () => void)(); await settle();
    expect(h.dialog().props).toMatchObject({ busy: false, error: h.t.deletion.failed });
    (h.dialog().props.onConfirm as () => void)(); await settle(); expect(h.onDelete).toHaveBeenCalledTimes(2); expect(h.dialog()).toBeUndefined();
  });
});
