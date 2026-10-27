import { normalizeKnowledgeVaultRoot, type AgentHostApi, type KnowledgeVaultSettings } from '@extalia/platform';

/**
 * The mock host's knowledge vault setting (W5): starts on the default vault; a chosen folder is
 * accepted when it is an absolute path outside the sample data folder, and a folder named like an
 * Obsidian vault (`…/Obsidian…`) reports `.obsidian`. Nothing on disk is read.
 */
export function createMockKnowledgeSettings(latency: () => Promise<void>): Pick<Required<AgentHostApi>, 'knowledgeSettings' | 'setKnowledgeVaultRoot'> {
  let current: KnowledgeVaultSettings = { kind: 'default', label: 'vaults/default', available: true, obsidian: false, watch: 'watching' };
  return {
    async knowledgeSettings() { await latency(); return structuredClone(current); },
    async setKnowledgeVaultRoot(raw) {
      await latency();
      const root = normalizeKnowledgeVaultRoot(raw);
      if (root === null) current = { kind: 'default', label: 'vaults/default', available: true, obsidian: false, watch: 'watching' };
      else {
        const name = root.split(/[\\/]+/).filter(Boolean).pop() ?? '';
        if (!name || /[\\/]\.extalia-vo(?:[\\/]|$)/.test(root)) throw new Error('Choose a folder outside the Extalia data folder.');
        current = { kind: 'custom', label: `custom:${name}`, path: root, available: true, obsidian: /obsidian/i.test(root), watch: 'watching' };
      }
      return structuredClone(current);
    },
  };
}
