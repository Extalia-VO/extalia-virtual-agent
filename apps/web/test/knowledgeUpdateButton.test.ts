import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, LearningScheduleSnapshot } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeUpdateButton } from '../src/knowledge/KnowledgeUpdateButton';
import { LEARNING_SCHEDULE_REFRESH_EVENT } from '../src/knowledge/LearningCountdown';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const id = hooks.index++;
    if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[id], (next: unknown) => { hooks.state[id] = next; }];
  },
  useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
  useEffect: (run: () => void) => { run(); },
}));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { hooks.state = []; hooks.index = 0; vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.unstubAllGlobals(); });
function harness() {
  let resolve!: (snapshot: LearningScheduleSnapshot) => void;
  const request = vi.fn(() => new Promise<LearningScheduleSnapshot>(done => { resolve = done; }));
  const props: Parameters<typeof KnowledgeUpdateButton>[0] = { t: MESSAGES.en, workspaceId: 'workspace-a', agents: { requestKnowledgeUpdate: request } as unknown as AgentHostApi };
  const render = () => { hooks.index = 0; return elements(KnowledgeUpdateButton(props)); };
  return { request, props, render, finish: () => resolve({ revision: 'r2', jobs: [], delaySeconds: 60, snoozeSeconds: 600 }) };
}
describe('manual Knowledge team update', () => {
  it('submits the selected workspace once, disables while pending and refreshes the shared notification after acknowledgement', async () => {
    const h = harness(); const refresh = vi.fn(); window.addEventListener(LEARNING_SCHEDULE_REFRESH_EVENT, refresh);
    const button = h.render().find(node => node.type === 'button')!;
    const click = button.props.onClick as () => void;
    click(); click();
    expect(h.request).toHaveBeenCalledExactlyOnceWith('workspace-a');
    expect(h.render().find(node => node.type === 'button')!.props.disabled).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    h.finish(); await settle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(h.render().find(node => node.type === 'button')!.props.disabled).toBe(false);
  });
  it.each(['en', 'id'] as const)('explains the idle team and ten-second wait in %s', language => {
    const h = harness(); h.props.t = MESSAGES[language];
    expect(h.render().find(node => node.type === 'button')!.props.title).toBe(MESSAGES[language].knowledge.updateTeamHint);
  });
  it('hides unsupported/global actions and preserves scope lockouts', () => {
    const h = harness(); h.props.disabled = true;
    (h.render().find(node => node.type === 'button')!.props.onClick as () => void)();
    expect(h.request).not.toHaveBeenCalled();
    h.props.workspaceId = undefined; expect(h.render()).toEqual([]);
    h.props.workspaceId = 'workspace-a'; h.props.agents = {} as AgentHostApi; expect(h.render()).toEqual([]);
  });
  it('shows a rejected host request without claiming that a meeting started', async () => {
    const h = harness(); h.request.mockRejectedValueOnce(new Error('No idle team is available.'));
    (h.render().find(node => node.type === 'button')!.props.onClick as () => void)();
    await settle();
    expect(h.render().find(node => node.props.role === 'alert')!.props.children).toBe('No idle team is available.');
    expect(h.render().find(node => node.type === 'button')!.props.disabled).toBe(false);
  });
});
