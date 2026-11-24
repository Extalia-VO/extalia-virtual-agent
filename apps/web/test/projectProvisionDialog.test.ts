import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { defaultOrchestration, type Workspace } from '@extalia/core';
import type {
  AgentHostApi,
  HostState,
  ProjectProvisionPreview,
  ProjectProvisionReceipt,
  SessionSummary,
} from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectProvisionDialog } from '../src/chat/ProjectProvisionDialog';
import { MESSAGES } from '../src/i18n';

// Exercise the dialog's real async handlers and committed layout phase using
// isolated in-memory hooks, matching sessionMoveDialog.test.ts.
const hooks = vi.hoisted(() => ({
  index: 0,
  state: [] as unknown[],
  deps: new Map<number, readonly unknown[]>(),
  memo: new Map<number, { deps: readonly unknown[]; value: unknown }>(),
  layout: [] as (() => void)[],
  effects: [] as (() => void)[],
}));

vi.mock('react', async original => {
  const effect = (queue: (() => void)[], run: () => void, deps: readonly unknown[]) => {
    const id = hooks.index++;
    const previous = hooks.deps.get(id);
    if (!previous || deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))) {
      hooks.deps.set(id, deps);
      queue.push(run);
    }
  };
  return {
    ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [
        hooks.state[id],
        (value: unknown) => {
          hooks.state[id] = typeof value === 'function' ? value(hooks.state[id]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const id = hooks.index++;
      return (hooks.state[id] ??= { current: initial });
    },
    useMemo: (compute: () => unknown, deps: readonly unknown[]) => {
      const id = hooks.index++;
      const prior = hooks.memo.get(id);
      if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
        hooks.memo.set(id, { deps, value: compute() });
      }
      return hooks.memo.get(id)!.value;
    },
    useId: () => 'provision-dialog',
    useEffect: (run: () => void, deps: readonly unknown[]) => effect(hooks.effects, run, deps),
    useLayoutEffect: (run: () => void, deps: readonly unknown[]) => effect(hooks.layout, run, deps),
  };
});

const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] =>
  Array.isArray(node)
    ? node.flatMap(elements)
    : isValidElement<Record<string, unknown>>(node)
      ? [node, ...elements(node.props.children as ReactNode)]
      : [];

const text = (node: ReactNode): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(text).join('')
      : isValidElement<{ children?: ReactNode }>(node)
        ? text(node.props.children)
        : '';

const stamp = '2026-11-24T00:00:00.000Z';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

function sampleState(workspaces: Workspace[] = []): HostState {
  return {
    setupComplete: true,
    workflow: 'managed',
    dataDirectory: '/Users/<name>/.extalia-vo',
    profile: { id: 'profile-default', name: 'Default' },
    connections: [{
      id: 'conn-1',
      name: 'Primary',
      preset: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      model: 'claude-sonnet-5-5',
      credential: { kind: 'none' },
      features: { memory: 'extalia', skills: 'extalia' },
      orchestration: defaultOrchestration('anthropic'),
      createdAt: stamp,
      updatedAt: stamp,
      credentialStatus: 'not-needed',
    }],
    workspaces,
    sessions: [],
    library: [],
    storage: { dataDirectory: '/Users/<name>/.extalia-vo', secretStore: 'memory' },
    host: { kind: 'bridge', version: 'test' },
  };
}

function harness(options: {
  initialMode?: 'create' | 'open';
  session?: SessionSummary;
  workspaces?: Workspace[];
} = {}) {
  const workspace: Workspace = {
    id: 'ws-1',
    profileId: 'profile-default',
    name: 'Existing',
    projectLocation: '/Users/<name>/Projects/existing',
    providerProfileId: 'conn-1',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const session: SessionSummary | undefined = 'session' in options
    ? options.session
    : {
      id: 'session-unassigned',
      workspaceId: null,
      connectionId: 'conn-1',
      title: 'Planning chat',
      control: 'managed',
      running: false,
      createdAt: stamp,
      lastActiveAt: stamp,
    };
  const defaultPreview: ProjectProvisionPreview = {
    reviewId: 'prov-review-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    mode: options.initialMode ?? 'create',
    targetPath: '/Users/<name>/Projects/new-app',
    parentPath: '/Users/<name>/Projects',
    workspaceName: 'new-app',
    runtimeId: 'extalia-native',
    connectionId: 'conn-1',
    permissions: { fileWrite: 'ask', commands: 'ask' },
    crossWorkspaceAccess: 'read-only',
    templateId: 'none',
    gitInit: true,
    gitInspection: { isGitRepo: true, branch: 'main', dirty: false, dirtyChangeCount: 0, protectedBranch: false },
    plannedActions: [
      { kind: 'create-folder', target: '/Users/<name>/Projects/new-app' },
      { kind: 'git-init', target: '/Users/<name>/Projects/new-app' },
      { kind: 'register-workspace', target: '/Users/<name>/Projects/new-app', detail: 'new-app' },
      ...(session ? [{ kind: 'attach-session' as const, target: session.id, detail: session.title }] : []),
    ],
    warnings: [],
    requiresWarningAcknowledgement: false,
    ...(session
      ? {
        attachSession: {
          sessionId: session.id,
          title: session.title,
          transfersHistory: false,
          permissionMode: 'workspace',
        },
      }
      : {}),
  };
  const agents = {
    previewProjectProvision: vi.fn(async () => defaultPreview),
    applyProjectProvision: vi.fn(),
    browseDirectories: vi.fn(),
  } as unknown as AgentHostApi;

  const props: Parameters<typeof ProjectProvisionDialog>[0] = {
    t: MESSAGES.en,
    agents,
    state: sampleState(options.workspaces ?? [workspace]),
    initialMode: options.initialMode ?? 'create',
    session,
    onClose: vi.fn(),
    onProvisioned: vi.fn(),
  };

  const render = () => {
    hooks.index = 0;
    const tree = ProjectProvisionDialog(props);
    for (const run of hooks.layout.splice(0)) run();
    for (const run of hooks.effects.splice(0)) run();
    return tree;
  };

  const inputById = (id: string) =>
    elements(render()).find(node => node.type === 'input' && node.props.id === id)!;

  const setInput = (id: string, value: string) => {
    const el = inputById(id);
    (el.props.onChange as (event: unknown) => void)({ target: { value } });
  };

  const button = (label: string) =>
    elements(render()).find(
      node => node.type === 'button' && node.props.role !== 'tab' && text(node.props.children as ReactNode) === label,
    )!;

  const click = (label: string) => {
    const el = button(label);
    (el.props.onClick as () => void)();
  };

  const checkboxes = () =>
    elements(render()).filter(node => node.type === 'input' && node.props.type === 'checkbox');

  return { props, render, inputById, setInput, button, click, checkboxes, defaultPreview };
}

beforeEach(() => {
  hooks.index = 0;
  hooks.state = [];
  hooks.deps.clear();
  hooks.memo.clear();
  hooks.layout = [];
  hooks.effects = [];
});

describe('ProjectProvisionDialog interactive workflow & safety', () => {
  it('validates folder name live, supports mode tabs with keyboard arrows, and labels cancel for unassigned planning', () => {
    const h = harness({ initialMode: 'create' });
    expect(h.button(MESSAGES.en.chat.provision.continueWithoutFiles)).toBeDefined();

    h.setInput('provision-dialog-folder-name', '../bad');
    const invalidMarkup = text(h.render());
    expect(invalidMarkup).toContain('Folder names cannot contain path separators');
    expect(h.button(MESSAGES.en.chat.provision.reviewAction).props.disabled).toBe(true);

    h.setInput('provision-dialog-folder-name', 'good-app');
    h.setInput('provision-dialog-parent', '/Users/<name>/Projects');
    expect(h.button(MESSAGES.en.chat.provision.reviewAction).props.disabled).toBe(false);

    const tablist = elements(h.render()).find(node => node.props.role === 'tablist')!;
    const focus = vi.fn();
    (tablist.props.onKeyDown as (event: unknown) => void)({
      key: 'ArrowRight',
      preventDefault: vi.fn(),
      currentTarget: { querySelectorAll: () => [{ focus }, { focus }] },
    });
    expect(focus).toHaveBeenCalledOnce();
    const openTab = elements(h.render()).find(node => node.props.id === 'provision-dialog-open-tab')!;
    expect(openTab.props['aria-selected']).toBe(true);
  });

  it('uses standard Cancel when opened with existing workspaces and no unassigned session', () => {
    const h = harness({ initialMode: 'open', session: undefined });
    const tree = h.render();
    const rendered = text(tree);
    expect(rendered).toContain(MESSAGES.en.common.cancel);
    expect(rendered).not.toContain(MESSAGES.en.chat.provision.continueWithoutFiles);
  });

  it('enforces confirmation and warning acknowledgement gates before applying dirty/protected previews', async () => {
    const h = harness({ initialMode: 'open' });
    const warningPreview: ProjectProvisionPreview = {
      ...h.defaultPreview,
      mode: 'open',
      targetPath: '/Users/<name>/Projects/dirty-protected',
      gitInspection: {
        isGitRepo: true,
        branch: 'main',
        dirty: true,
        dirtyChangeCount: 3,
        protectedBranch: true,
      },
      warnings: [
        { code: 'dirty-repository', detail: '3 uncommitted changes' },
        { code: 'protected-branch', detail: 'Branch main is protected' },
      ],
      requiresWarningAcknowledgement: true,
    };
    vi.mocked(h.props.agents.previewProjectProvision!).mockResolvedValue(warningPreview);
    const receipt: ProjectProvisionReceipt = {
      ok: true,
      partial: false,
      mode: 'open',
      targetPath: warningPreview.targetPath,
      workspace: {
        id: 'ws-new',
        profileId: 'profile-default',
        name: 'dirty-protected',
        projectLocation: warningPreview.targetPath,
        providerProfileId: 'conn-1',
        createdAt: stamp,
        updatedAt: stamp,
      },
      attachedSessionId: 'session-unassigned',
      steps: [{ step: 'register-workspace', status: 'completed', target: warningPreview.targetPath }],
      state: h.props.state,
    };
    vi.mocked(h.props.agents.applyProjectProvision!).mockResolvedValue(receipt);

    h.setInput('provision-dialog-target', warningPreview.targetPath);
    h.click(MESSAGES.en.chat.provision.reviewAction);

    await vi.waitFor(() => {
      expect(text(h.render())).toContain(MESSAGES.en.chat.provision.reviewHeading);
    });
    const reviewText = text(h.render());
    expect(reviewText).toContain(warningPreview.targetPath);
    expect(reviewText).toContain(MESSAGES.en.chat.provision.attachContextNotice);
    expect(reviewText).toContain(MESSAGES.en.chat.provision.gitProtectedBranch);
    expect(reviewText).toContain(MESSAGES.en.chat.provision.warningCodes['dirty-repository']);

    // Initially Apply is disabled until both confirm and acknowledgeWarnings are checked.
    expect(h.button(MESSAGES.en.chat.provision.applyOpen).props.disabled).toBe(true);
    const boxesAfterPreview = h.checkboxes();
    // 0: attachSession, 1: confirmed, 2: acknowledgeWarnings
    (boxesAfterPreview[1]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    expect(h.button(MESSAGES.en.chat.provision.applyOpen).props.disabled).toBe(true);
    (h.checkboxes()[2]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    expect(h.button(MESSAGES.en.chat.provision.applyOpen).props.disabled).toBe(false);

    h.click(MESSAGES.en.chat.provision.applyOpen);
    await vi.waitFor(() => {
      expect(h.props.agents.applyProjectProvision).toHaveBeenCalledWith({
        reviewId: warningPreview.reviewId,
        acknowledgeWarnings: true,
      });
      expect(h.props.onProvisioned).toHaveBeenCalledExactlyOnceWith(receipt);
    });
  });

  it('renders error and itemized step receipt on partial failure', async () => {
    const h = harness({ initialMode: 'create' });
    const partialFailure: ProjectProvisionReceipt = {
      ok: false,
      partial: true,
      mode: 'create',
      targetPath: '/Users/<name>/Projects/new-app',
      steps: [
        { step: 'create-folder', status: 'completed', target: '/Users/<name>/Projects/new-app' },
        { step: 'git-init', status: 'failed', target: '/Users/<name>/Projects/new-app', detail: 'git failed' },
        { step: 'register-workspace', status: 'skipped', target: '/Users/<name>/Projects/new-app' },
      ],
      error: 'Git initialization failed after creating folder.',
    };
    vi.mocked(h.props.agents.applyProjectProvision!).mockResolvedValue(partialFailure);

    h.setInput('provision-dialog-parent', '/Users/<name>/Projects');
    h.setInput('provision-dialog-folder-name', 'new-app');
    h.click(MESSAGES.en.chat.provision.reviewAction);
    await vi.waitFor(() => expect(h.checkboxes().length).toBe(3));
    (h.checkboxes()[2]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    h.click(MESSAGES.en.chat.provision.applyCreate);

    await vi.waitFor(() => {
      const output = text(h.render());
      expect(output).toContain('Git initialization failed after creating folder.');
      expect(output).toContain(MESSAGES.en.chat.provision.stepStatuses.completed);
      expect(output).toContain(MESSAGES.en.chat.provision.stepStatuses.failed);
      expect(output).toContain(MESSAGES.en.chat.provision.stepStatuses.skipped);
    });
    expect(h.props.onProvisioned).not.toHaveBeenCalled();
  });

  it('drops delayed preview results if committed inputs change while request is in flight', async () => {
    const h = harness({ initialMode: 'create' });
    const pending = deferred<ProjectProvisionPreview>();
    vi.mocked(h.props.agents.previewProjectProvision!).mockReturnValue(pending.promise);

    h.setInput('provision-dialog-parent', '/Users/<name>/Projects');
    h.setInput('provision-dialog-folder-name', 'first-app');
    h.click(MESSAGES.en.chat.provision.reviewAction);
    expect(h.props.agents.previewProjectProvision).toHaveBeenCalledOnce();

    // Mutate input while preview is in flight.
    h.setInput('provision-dialog-folder-name', 'second-app');
    h.render();

    pending.resolve(h.defaultPreview);
    await vi.waitFor(() => {
      expect(h.button(MESSAGES.en.chat.provision.reviewAction).props.disabled).toBe(false);
    });
    expect(text(h.render())).not.toContain(MESSAGES.en.chat.provision.reviewHeading);
  });
});
