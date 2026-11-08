import type { Workspace } from '@extalia/core';
import type { AgentHostApi, ConnectionView, SessionContextUsage, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer } from '../src/chat/Composer';
import { MemoryContextPanel, memoryContextScope } from '../src/chat/MemoryContextPanel';
import { MESSAGES, type Language } from '../src/i18n';

const AT = '2026-10-08T00:00:00.000Z';
const workspace: Workspace = { id: 'workspace-a', profileId: 'profile', name: 'Project A', providerProfileId: 'connection-a', createdAt: AT, updatedAt: AT };
const connection = (overrides: Partial<ConnectionView> = {}): ConnectionView => ({
  id: 'connection-a', name: 'Example provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1',
  model: 'example-model', credential: { kind: 'none' }, credentialStatus: 'not-needed', features: { memory: 'extalia', skills: 'extalia' },
  orchestration: { enabled: true, maxDelegations: 3, tiers: {} }, createdAt: AT, updatedAt: AT, ...overrides,
});
const context = (overrides: Partial<SessionContextUsage> = {}): SessionContextUsage => ({
  usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 0, updatedAt: AT, ...overrides,
});
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-a', workspaceId: workspace.id, connectionId: 'connection-a', title: 'Example task', control: 'managed',
  createdAt: AT, lastActiveAt: AT, running: false, context: context(), ...overrides,
});

function panel({ language = 'en', selectedConnection = connection(), reading, knowledge = false }: {
  language?: Language; selectedConnection?: ConnectionView | null; reading?: SessionContextUsage; knowledge?: boolean;
} = {}) {
  return renderToStaticMarkup(createElement(MemoryContextPanel, {
    t: MESSAGES[language], language, id: 'memory-details', workspaceName: workspace.name,
    connection: selectedConnection ?? undefined, context: reading, onOpenSettings() {}, onOpenSkills() {},
    onOpenKnowledge: knowledge ? () => undefined : undefined,
  }));
}

describe('Native memory and context disclosure', () => {
  it('provides a native keyboard/touch disclosure with ownership, permissions and existing destinations', () => {
    const html = panel({ knowledge: true });
    expect(html).toContain('<details id="memory-details"');
    expect(html).toContain('<summary>');
    expect(html).toContain('role="region" aria-label="Memory &amp; context" tabindex="0"');
    expect(html).toContain('Project A');
    expect(html).toContain('Example provider');
    expect(html).toContain('The lead can save confirmed facts; team workers can only read them.');
    expect(html).toContain('Importing them into Knowledge creates separate vault copies.');
    expect(html).toContain('Memory and skill settings apply to every chat using this connection.');
    expect(html).toContain('Connection settings</button>');
    expect(html).toContain('Open Grimoire</button>');
    expect(html).toContain('Open Knowledge</button>');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('<details open');
  });

  it('shows disabled memory honestly and omits unsupported destinations', () => {
    const html = panel({ selectedConnection: connection({ features: { memory: 'off', skills: 'off' } }) });
    expect(html).toContain('Extalia workspace recall is off. Existing notes are kept.');
    expect(html).not.toContain('The lead can save');
    expect(html).not.toContain('Extalia offers its built-in');
    expect(html).not.toContain('Open Knowledge');
  });

  it('distinguishes provider-owned memory and missing connection settings', () => {
    const provider = panel({ selectedConnection: connection({ features: { memory: 'provider', skills: 'provider' } }) });
    expect(provider).toContain('Memory is handled by the connection provider.');
    expect(provider).not.toContain('The lead can save');
    const missing = panel({ selectedConnection: null });
    expect(missing).toContain('Connection not available');
    expect(missing).toContain('The connection’s memory settings are not available.');
    expect(missing).not.toContain('The lead can save');
  });

  it('keeps absent context unknown instead of showing a zero reading', () => {
    const html = panel();
    expect(html).toContain('Context not reported');
    expect(html).toContain('No context reading is available for this conversation yet.');
    expect(html).not.toContain('0 tokens');
    expect(html).not.toContain('0%');
    expect(html).not.toContain('Prompt size reported');
    expect(html).not.toContain('<time');
  });

  it('makes latest provider reading, known window and timestamp visible', () => {
    const html = panel({ reading: context() });
    expect(html).toContain('62% · 124k / 200k');
    expect(html).toContain('Latest lead request');
    expect(html).toContain('Prompt size reported by the model provider.');
    expect(html).toContain('No context compactions recorded.');
    expect(html).toContain(`<time dateTime="${AT}">`);
    expect(html).toContain('Turn usage appears below each response.');
    expect(html).not.toContain('Estimated from');
  });

  it('keeps estimates, unknown windows, warning and compactions visible without a tooltip', () => {
    const estimated = panel({ reading: context({ estimated: true, windowTokens: undefined, compactions: 2 }) });
    expect(estimated).toContain('≈124k tokens');
    expect(estimated).toContain('Estimated from the text sent, because the model reported no usage');
    expect(estimated).toContain('The window size of this model is not known');
    expect(estimated).toContain('Compacted 2 times');
    const warning = panel({ reading: context({ usedTokens: 195_000 }) });
    expect(warning).toContain('Almost at the context limit');
    expect(warning).not.toContain('Estimated from');
  });

  it('renders the same ownership and estimated-context details in Indonesian', () => {
    const html = panel({ language: 'id', reading: context({ estimated: true, compactions: 1 }), knowledge: true });
    expect(html).toContain('Memori &amp; konteks');
    expect(html).toContain('worker tim hanya bisa membacanya');
    expect(html).toContain('salinan terpisah di vault');
    expect(html).toContain(MESSAGES.id.context.estimated);
    expect(html).toContain('Dipadatkan sekali');
    expect(html).toContain('Buka Grimoire');
    expect(html).toContain('Buka Pengetahuan');
    expect(html).not.toContain('Latest lead request');
  });
});

describe('memory disclosure scope', () => {
  const original = connection();
  const replacement = connection({ id: 'connection-b', name: 'Another provider', features: { memory: 'off', skills: 'off' } });
  const identity = { profile: { id: 'profile', name: 'Example' }, dataDirectory: '/example/profile', storage: { dataDirectory: '/example/profile', secretStore: 'memory' as const }, host: { kind: 'bridge' as const, version: '0.0.0' } };
  const state = { ...identity, connections: [original, replacement] };

  it('uses the saved session connection even after the workspace default changes', () => {
    const changed = { ...workspace, providerProfileId: replacement.id };
    expect(memoryContextScope(state, changed, session())?.connection).toBe(original);
    expect(memoryContextScope(state, changed)?.connection).toBe(replacement);
    expect(memoryContextScope(state, changed)?.context).toBeUndefined();
  });

  it('does not substitute the default when the saved session connection is missing', () => {
    const scope = memoryContextScope({ ...identity, connections: [replacement] }, { ...workspace, providerProfileId: replacement.id }, session());
    expect(scope?.connection).toBeUndefined();
  });

  it('changes disclosure ownership between sessions, workspaces and connections', () => {
    const first = memoryContextScope(state, workspace, session());
    const nextSession = memoryContextScope(state, workspace, session({ id: 'session-b', connectionId: replacement.id, context: undefined }));
    expect(nextSession?.connection).toBe(replacement);
    expect(nextSession?.context).toBeUndefined();
    expect(nextSession?.key).not.toBe(first?.key);
    expect(memoryContextScope(state, { ...workspace, id: 'workspace-b' })?.key).not.toBe(memoryContextScope(state, workspace)?.key);
    expect(memoryContextScope(state, { ...workspace, providerProfileId: replacement.id })?.key).not.toBe(memoryContextScope(state, workspace)?.key);
  });

  it('excludes observed, Hermes and mismatched sessions while respecting saved Native sessions', () => {
    expect(memoryContextScope(state, workspace, session({ control: 'observed' }))).toBeUndefined();
    expect(memoryContextScope(state, workspace, session({ runtime: { id: 'hermes', profile: 'default' } }))).toBeUndefined();
    expect(memoryContextScope(state, { ...workspace, runtimeId: 'hermes' })).toBeUndefined();
    expect(memoryContextScope(state, { ...workspace, id: 'workspace-b' }, session())).toBeUndefined();
    expect(memoryContextScope(state, { ...workspace, runtimeId: 'hermes' }, session())?.connection).toBe(original);
  });

  it('shares drafts across sessions/connections while separating profiles and data directories', () => {
    const first = memoryContextScope(state, workspace, session())!;
    const otherSession = memoryContextScope(state, workspace, session({ id: 'session-b', connectionId: replacement.id }))!;
    expect(otherSession.draftKey).toBe(first.draftKey);
    expect(otherSession.key).not.toBe(first.key);
    const otherProfile = memoryContextScope({ ...state, profile: { ...state.profile, id: 'another-profile' } }, workspace, session())!;
    const otherDirectory = memoryContextScope({ ...state, dataDirectory: '/example/another-profile' }, workspace, session())!;
    const otherHost = memoryContextScope({ ...state, host: { ...state.host, kind: 'desktop' } }, workspace, session())!;
    for (const scope of [otherProfile, otherDirectory, otherHost]) {
      expect(scope.key).not.toBe(first.key);
      expect(scope.draftKey).not.toBe(first.draftKey);
    }
  });
});

describe('composer context access', () => {
  const render = (interactive: boolean) => renderToStaticMarkup(createElement(Composer, {
    t: MESSAGES.en, agents: {} as AgentHostApi, session: session(), workspaceId: workspace.id,
    hermes: false, running: false, waiting: false, readOnly: false, stopping: false,
    onSend: async () => false, onStop() {}, contextPanelId: interactive ? 'memory-details' : undefined,
    onOpenContext: interactive ? () => undefined : undefined,
  }));

  it('offers a labelled button linked to the disclosure instead of a tooltip-only ring', () => {
    const html = render(true);
    expect(html).toContain('<button type="button" class="composer-ring composer-ring-button');
    expect(html).toContain('aria-controls="memory-details"');
    expect(html).toContain('aria-label="Context 62% · 124k / 200k"');
    expect(html).not.toContain('role="img"');
  });

  it('preserves the existing static ring for composer callers without a disclosure', () => {
    const html = render(false);
    expect(html).toContain('<span class="composer-ring tone-normal" role="img"');
    expect(html).not.toContain('aria-controls="memory-details"');
  });
});
