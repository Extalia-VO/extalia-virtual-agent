import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VaultProfilesCatalog } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeVaultContext, type KnowledgeVaultContextProps } from '../src/knowledge/KnowledgeVaultContext';
import { KnowledgeStatusBar } from '../src/knowledge/KnowledgePage';
import { KnowledgeVaultView } from '../src/pages/settings/KnowledgeVaultSection';
import { MESSAGES } from '../src/i18n';

const root = '/example/notes/shared vault with a long descriptive folder name';
const catalog: VaultProfilesCatalog = { revision: 'review-one', defaultProfileId: 'default', profiles: [
  { id: 'shared', name: 'Team notes', kind: 'custom', root, workspaceIds: ['one', 'two'], minutesEnabled: true, automaticLearning: { enabled: false, skills: false, notes: false } },
], workspaces: [{ id: 'one', name: 'Project One', profileId: 'shared' }, { id: 'two', name: 'Project Two', profileId: 'shared' }] };
const props = (patch: Partial<KnowledgeVaultContextProps> = {}): KnowledgeVaultContextProps => ({
  t: MESSAGES.en, catalog, profile: catalog.profiles[0], workspaceId: 'one', loading: false, scoped: true, locked: false,
  onRefresh: vi.fn(), configuration: createElement('div', null, 'folder-controls'), ...patch,
});

describe('Knowledge vault connection', () => {
  it('uses the shared library selector and offers the confirmed folder path for copying', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeVaultContext, props({
      workspaces: [{ id: 'one', name: 'Project One' }, { id: 'two', name: 'Project Two' }] as KnowledgeVaultContextProps['workspaces'],
      onWorkspace: vi.fn(),
    })));
    expect(html).toContain('glass-select-trigger');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-workspace-id="one"');
    expect(html).toContain(MESSAGES.en.common.copyLabel(MESSAGES.en.knowledgeContext.location));
    expect(html).not.toContain('href="file:');
  });

  it('shows one authoritative absolute folder with shared impact and a single progressive configuration entry', () => {
    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language], html = renderToStaticMarkup(createElement(KnowledgeVaultContext, props({ t })));
      expect(html.split(root)).toHaveLength(2);
      expect(html).toContain(t.knowledgeContext.shared('Project Two'));
      expect(html).toContain(t.knowledgeContext.configure);
      expect(html).not.toContain('<details class="knowledge-connection-config" open');
      expect(html).not.toContain(t.vaultProfiles.title);
    }
  });

  it('never labels unavailable or unsupported scope with a stale confirmed root', () => {
    for (const patch of [{ loading: true }, { error: 'Connection unavailable' }, { scoped: false }]) {
      const html = renderToStaticMarkup(createElement(KnowledgeVaultContext, props(patch)));
      expect(html).not.toContain(root);
      expect(html).not.toContain('folder-controls');
    }
  });

  it('labels the old location explicitly after an external binding change', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeVaultContext, props({ stale: true, locked: true })));
    expect(html).toContain(MESSAGES.en.knowledgeContext.previousLocation);
    expect(html).not.toContain(MESSAGES.en.knowledgeContext.locked);
    expect(html).not.toContain(MESSAGES.en.knowledgeContext.browseHint);
    expect(html).not.toContain(MESSAGES.en.knowledgeContext.configure);
  });

  it('keeps sync counts without repeating the index label and keeps folder details outside the primary flow', () => {
    const status = renderToStaticMarkup(createElement(KnowledgeStatusBar, { t: MESSAGES.en, language: 'en',
      status: { state: 'ready', vaultRoot: 'custom:shared vault', vaultPresent: true, generation: 1, counts: { notes: 2, edges: 0, unresolvedLinks: 0, skipped: 0 }, skipped: [] },
      syncing: false, hideVault: true, onSync: vi.fn() }));
    expect(status).toContain('2 notes'); expect(status).not.toContain('custom:shared vault');
    const form = renderToStaticMarkup(createElement(KnowledgeVaultView, { t: MESSAGES.en, settings: { kind: 'custom', label: 'custom:shared vault', path: root, available: true, obsidian: true, watch: 'watching' },
      busy: true, compact: true, onDefault: vi.fn(), onChoose: vi.fn() }));
    expect(form).not.toContain('settings-data-folder');
    expect(form).toContain('knowledge-folder-behavior');
    expect(form).toContain('disabled=""');
    expect(form).toContain(MESSAGES.en.knowledgeVault.useManaged);
  });
});
