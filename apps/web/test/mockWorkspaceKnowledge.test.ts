import { describe, expect, it } from 'vitest';
import type { AgentHostApi, KnowledgeNoteFile, KnowledgeStatus, VaultProfile } from '@extalia/platform';
import { createMockPlatform } from '../src/host/mockHost';

async function ready() {
  const agents = createMockPlatform({ seed: 'ready', host: 'bridge', knowledge: 'empty' }).capabilities.agents!;
  const state = await agents.getState();
  for (const session of state.sessions) if (session.running) await agents.cancel(session.id);
  return { agents, workspaceId: state.workspaces[0]!.id };
}
const binding = (profile: VaultProfile) => ({ profileId: profile.id, root: profile.root });
const read = (agents: AgentHostApi, workspaceId: string, profile: VaultProfile) =>
  agents.workspaceKnowledge!(workspaceId, 'readKnowledgeNote', ['Context.md'], binding(profile)) as Promise<KnowledgeNoteFile | null>;

describe('development workspace Knowledge scope', () => {
  it('keeps separate in-memory roots and refuses stale writes after a folder switch', async () => {
    const { agents, workspaceId } = await ready();
    const initial = await agents.listVaultProfiles!();
    let catalog = await agents.saveVaultProfile!({ name: 'Separate notes', vaultRoot: '/example/vault-one', workspaceIds: [workspaceId],
      minutesEnabled: false, expectedRevision: initial.revision });
    const first = catalog.profiles.find(profile => profile.name === 'Separate notes')!;
    await agents.workspaceKnowledge!(workspaceId, 'writeKnowledgeNote', [{ path: 'Context.md', content: '# First vault\n', expectedSha256: null }], binding(first));
    await agents.workspaceKnowledge!(workspaceId, 'setKnowledgeVaultRoot', ['/example/vault-two'], binding(first));
    catalog = await agents.listVaultProfiles!();
    const second = catalog.profiles.find(profile => profile.id === first.id)!;
    expect(await read(agents, workspaceId, second)).toBeNull();
    await agents.workspaceKnowledge!(workspaceId, 'writeKnowledgeNote', [{ path: 'Context.md', content: '# Second vault\n', expectedSha256: null }], binding(second));
    await expect(agents.workspaceKnowledge!(workspaceId, 'writeKnowledgeNote', [{ path: 'Context.md', content: 'Wrong destination', expectedSha256: null }], binding(first))).rejects.toThrow(/changed/);
    expect((await read(agents, workspaceId, second))?.body).toContain('Second vault');
    await agents.workspaceKnowledge!(workspaceId, 'setKnowledgeVaultRoot', [first.root], binding(second));
    expect((await read(agents, workspaceId, first))?.body).toContain('First vault');
  });

  it('restores the default vault data and rejects memory imports from another profile', async () => {
    const { agents, workspaceId } = await ready();
    let catalog = await agents.listVaultProfiles!();
    const original = catalog.profiles.find(profile => profile.id === catalog.defaultProfileId)!;
    await agents.workspaceKnowledge!(workspaceId, 'writeKnowledgeNote', [{ path: 'Context.md', content: '# Original default\n', expectedSha256: null }], binding(original));
    await agents.workspaceKnowledge!(workspaceId, 'setKnowledgeVaultRoot', ['/example/custom-default'], binding(original));
    catalog = await agents.listVaultProfiles!();
    const custom = catalog.profiles.find(profile => profile.id === original.id)!;
    const status = await agents.workspaceKnowledge!(workspaceId, 'knowledgeStatus', [], binding(custom)) as KnowledgeStatus;
    expect(status.vaultRoot).toBe('custom:custom-default'); expect(status.counts?.notes).toBe(0);
    await agents.workspaceKnowledge!(workspaceId, 'setKnowledgeVaultRoot', [null], binding(custom));
    expect((await read(agents, workspaceId, original))?.body).toContain('Original default');
    const other = (await agents.getState()).workspaces.find(workspace => workspace.id !== workspaceId)!;
    catalog = await agents.listVaultProfiles!();
    await agents.saveVaultProfile!({ name: 'Other profile', vaultRoot: '/example/other', workspaceIds: [other.id], minutesEnabled: false, expectedRevision: catalog.revision });
    await expect(agents.workspaceKnowledge!(workspaceId, 'importMemoryNotes', [{ workspaceId: other.id, dryRun: true }], binding(original))).rejects.toThrow(/assigned/);
  });
});
