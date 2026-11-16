import type { KnowledgeVaultSettings } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { KnowledgeVaultView, vaultSettingsPresent } from '../src/pages/settings/KnowledgeVaultSection';

const t = MESSAGES.en;
const view = (settings: KnowledgeVaultSettings) => renderToStaticMarkup(createElement(KnowledgeVaultView, {
  t, settings, busy: false, onDefault: vi.fn(), onChoose: vi.fn(),
}));

describe('Settings: knowledge vault', () => {
  it('shows the default vault with the safety note and a folder picker on Desktop', () => {
    const html = view({ kind: 'default', label: 'vaults/default', available: true, obsidian: false, watch: 'watching' });
    expect(html).toContain(t.knowledgeVault.title);
    expect(html).toContain('vaults/default');
    expect(html).toContain('managed_by: extalia');
    expect(html).toContain('.obsidian folder untouched');
    expect(html).toContain('Choose folder…');
    expect(html).not.toContain('type="text"');
  });

  it('shows a copyable location with a folder picker on Web and explains unavailable Obsidian vaults', () => {
    const html = view({ kind: 'custom', label: 'custom:Vault', path: '/data/notes/Vault', available: false, problem: 'That folder does not exist.', obsidian: true, watch: 'off' });
    expect(html).toContain('/data/notes/Vault');
    expect(html).not.toContain('<input');
    expect(html).toContain(t.knowledgeVault.choose);
    expect(html).toContain('copy-button');
    expect(html).toContain('Obsidian vault detected.');
    expect(html).toContain('That folder does not exist.');
    expect(html).toContain(t.knowledgeVault.unavailable);
  });

  it('the mock host serves the setting with the platform validation', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(vaultSettingsPresent(agents)).toBe(true);
    await expect(agents.setKnowledgeVaultRoot!('notes')).rejects.toThrow(/full path/);
    expect(await agents.setKnowledgeVaultRoot!('/data/notes/Obsidian')).toMatchObject({ kind: 'custom', label: 'custom:Obsidian', obsidian: true });
    expect(await agents.setKnowledgeVaultRoot!(null)).toMatchObject({ kind: 'default' });
    expect(vaultSettingsPresent(createMockPlatform({ seed: 'ready', host: 'bridge', knowledge: 'off' }).capabilities.agents)).toBe(false);
  });
});
