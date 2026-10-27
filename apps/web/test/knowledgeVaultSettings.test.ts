import type { KnowledgeVaultSettings } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { KnowledgeVaultView, vaultSettingsPresent } from '../src/pages/settings/KnowledgeVaultSection';

const t = MESSAGES.en;
const view = (settings: KnowledgeVaultSettings, canPick: boolean) => renderToStaticMarkup(createElement(KnowledgeVaultView, {
  t, settings, busy: false, canPick, path: settings.path ?? '', onPath: vi.fn(), onDefault: vi.fn(), onChoose: vi.fn(), onApply: vi.fn(),
}));

describe('Settings: knowledge vault', () => {
  it('shows the default vault with the safety note and a folder picker on Desktop', () => {
    const html = view({ kind: 'default', label: 'vaults/default', available: true, obsidian: false, watch: 'watching' }, true);
    expect(html).toContain('Knowledge vault');
    expect(html).toContain('vaults/default');
    expect(html).toContain('managed_by: extalia');
    expect(html).toContain('.obsidian folder untouched');
    expect(html).toContain('Choose folder…');
    expect(html).not.toContain('type="text"');
  });

  it('offers a path field without a picker and explains an Obsidian vault and an unavailable folder', () => {
    const html = view({ kind: 'custom', label: 'custom:Vault', path: '/Users/me/Vault', available: false, problem: 'That folder does not exist.', obsidian: true, watch: 'off' }, false);
    expect(html).toContain('/Users/me/Vault');
    expect(html).toContain('type="text"');
    expect(html).toContain('Obsidian vault');
    expect(html).toContain('That folder does not exist.');
    expect(html).toContain(t.knowledgeVault.unavailable);
  });

  it('the mock host serves the setting with the platform validation', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(vaultSettingsPresent(agents)).toBe(true);
    await expect(agents.setKnowledgeVaultRoot!('notes')).rejects.toThrow(/full path/);
    expect(await agents.setKnowledgeVaultRoot!('/Users/me/Obsidian')).toMatchObject({ kind: 'custom', label: 'custom:Obsidian', obsidian: true });
    expect(await agents.setKnowledgeVaultRoot!(null)).toMatchObject({ kind: 'default' });
    expect(vaultSettingsPresent(createMockPlatform({ seed: 'ready', host: 'bridge', knowledge: 'off' }).capabilities.agents)).toBe(false);
  });
});
