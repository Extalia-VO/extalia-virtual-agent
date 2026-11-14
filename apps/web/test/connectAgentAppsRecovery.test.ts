import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentAppRecoveryReport } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { ConnectAgentAppsCard } from '../src/pages/ConnectAgentAppsCard';

// Same in-memory hook harness as connectAgentAppsApply.test.ts.
const hooks = vi.hoisted(() => ({
  index: 0, state: [] as unknown[], mounted: true,
  effects: new Map<number, { dependencies?: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
}));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.effects.get(index);
    if (previous && dependencies && previous.dependencies?.every((value, at) => Object.is(value, dependencies[at]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.effects.set(index, { dependencies, cleanup: cleanup || undefined });
    });
  },
  useId: () => {
    const index = hooks.index++;
    return hooks.state[index] ??= `hook-${index}`;
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    return hooks.state[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => {
      hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value;
    }];
  },
}));

function mount(props: Parameters<typeof ConnectAgentAppsCard>[0]) {
  let formKey: string | null | undefined;
  return () => {
    hooks.index = 0;
    const form = ConnectAgentAppsCard(props);
    if (formKey !== undefined && formKey !== form.key) {
      for (const [index, effect] of hooks.effects) if (index >= hooks.index) { effect.cleanup?.(); hooks.effects.delete(index); }
      hooks.state.length = hooks.index;
    }
    formKey = form.key;
    const Form = form.type as (props: Parameters<typeof ConnectAgentAppsCard>[0]) => ReactNode;
    const tree = Form(form.props);
    for (const effect of hooks.pending.splice(0)) effect();
    return tree;
  };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children as ReactNode) : '';
const button = (node: ReactNode, label: string) => elements(node).find(element => element.type === 'button' && text(element.props.children as ReactNode) === label);
const panel = (node: ReactNode) => elements(node).find(element => element.type === 'div' && element.props.role === 'region' && element.props['aria-label'] === MESSAGES.en.agentApps.recovery.title);

beforeEach(() => { hooks.index = 0; hooks.state = []; hooks.effects.clear(); hooks.pending = []; hooks.mounted = true; });
afterEach(() => { for (const effect of hooks.effects.values()) effect.cleanup?.(); hooks.effects.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const t = MESSAGES.en.agentApps;
function setup(report: AgentAppRecoveryReport) {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
  const recover = vi.fn(async (action: 'preview' | 'rollback' | 'keep') => action === 'preview' ? report : { action, restored: [], resolved: true } as AgentAppRecoveryReport);
  const agents = { ...base, recoverAgentAppConnection: recover };
  return { recover, render: mount({ t: MESSAGES.en, agents }) };
}
const interrupted = (states: ('not-applied' | 'applied' | 'changed')[]): AgentAppRecoveryReport => ({
  action: 'preview', restored: [], resolved: false,
  operation: { operation: 'connect', app: 'codex', startedAt: '2026-10-29T12:00:00Z', entries: states.map((state, at) => ({ target: `/home/<name>/.codex/file${at}`, state })) },
});

describe('interrupted connection recovery panel', () => {
  it('shows no panel without an interrupted operation', async () => {
    const { recover, render } = setup({ action: 'preview', restored: [], resolved: false });
    render();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledWith('preview'));
    await vi.waitFor(() => expect(button(render(), t.connect)).toBeDefined());
    expect(panel(render())).toBeUndefined();
    expect(button(render(), t.connect)!.props.disabled).toBe(false);
  });

  it('lists entries with localized states and blocks connect while interrupted', async () => {
    const { render } = setup(interrupted(['applied', 'not-applied']));
    render();
    await vi.waitFor(() => expect(panel(render())).toBeDefined());
    const content = text(panel(render())!.props.children as ReactNode);
    expect(content).toContain('file0');
    expect(content).toContain(t.recovery.states.applied);
    expect(content).toContain(t.recovery.states['not-applied']);
    expect(button(render(), t.recovery.rollback)!.props.disabled).toBe(false);
    expect(button(render(), t.connect)!.props.disabled).toBe(true);
  });

  it('disables rollback when a file changed since', async () => {
    const { render } = setup(interrupted(['applied', 'changed']));
    render();
    await vi.waitFor(() => expect(panel(render())).toBeDefined());
    expect(button(render(), t.recovery.rollback)!.props.disabled).toBe(true);
    expect(text(panel(render())!.props.children as ReactNode)).toContain(t.recovery.changedHint);
    expect(button(render(), t.recovery.keep)!.props.disabled).toBe(false);
  });

  it('keeps the files only after an explicit confirmation', async () => {
    const { recover, render } = setup(interrupted(['applied']));
    render();
    await vi.waitFor(() => expect(button(render(), t.recovery.keep)).toBeDefined());
    (button(render(), t.recovery.keep)!.props.onClick as () => void)();
    expect(recover).not.toHaveBeenCalledWith('keep');
    (button(render(), t.recovery.confirm)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledWith('keep'));
  });
});
