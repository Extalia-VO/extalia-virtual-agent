import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import { normalizeAutomaticLearningPolicy, normalizeSaveVaultProfile, type AutomaticLearningPolicy, type SaveVaultProfileInput, type VaultProfilesCatalog } from '@extalia/platform';
import { validateVaultRoot } from './knowledgeVault.js';

export interface StoredVaultProfiles { profiles: { id: string; name: string; vaultRoot: string | null; minutesEnabled?: boolean; minutesRoot?: string; automaticLearning?: AutomaticLearningPolicy; learningRoot?: string }[] }
interface Snapshot { profiles?: StoredVaultProfiles; workspaces: readonly Workspace[]; defaultProfile: { id: string; name: string }; defaultRoot: string }
export interface VaultProfilesOptions {
  dataDirectory: string;
  homeDirectory: string;
  read(): Snapshot;
  /** Atomically persist catalog metadata and Workspace.profileId bindings in the host config. */
  commit(profiles: StoredVaultProfiles, workspaces: Workspace[]): Promise<void>;
  busy(): boolean;
  /** Native daemon creates only its own managed vault directories. No JavaScript write fallback. */
  ensureManagedRoot?(profileId: string): Promise<string>;
}
const error = (message: string) => Object.assign(new Error(message), { name: 'UserError' });
const inside = (a: string, b: string) => {
  const fold = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  const relative = path.relative(fold(b), fold(a));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const samePath = (a: string, b: string) => inside(a, b) && inside(b, a);
const canonical = async (root: string): Promise<string> => {
  try { return await realpath(root); }
  catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    const parent = path.dirname(root);
    if (parent === root) throw failure;
    return path.join(await canonical(parent), path.basename(root));
  }
};

/** One authoritative Workspace.profileId binding and one vault per profile. No file-tool permissions change. */
export class VaultProfiles {
  private changing = false;
  constructor(private readonly options: VaultProfilesOptions) {}

  /** The daemon's indexed default is always vaults/default, independently of the workspace profile id. */
  private indexedOwned(snapshot: Snapshot, data: string, root: string): boolean {
    const expected = path.join(data, 'vaults', 'default');
    const selected = path.resolve(snapshot.defaultRoot);
    // The host data directory may itself be reached through an existing alias. Unrelated vault aliases
    // still take the custom-root validator, including its symlink and data-directory restrictions.
    return samePath(root, expected) && (samePath(selected, expected)
      || samePath(selected, path.resolve(this.options.dataDirectory, 'vaults', 'default')));
  }

  private stored(snapshot: Snapshot): StoredVaultProfiles {
    const profiles = snapshot.profiles?.profiles;
    if (profiles === undefined) return { profiles: [] };
    if (!Array.isArray(profiles) || profiles.length > 64 || profiles.some(profile => !profile || typeof profile.id !== 'string' || !profile.id || typeof profile.name !== 'string'
      || !profile.name || profile.name.length > 120 || (profile.vaultRoot !== null && (typeof profile.vaultRoot !== 'string' || !path.isAbsolute(profile.vaultRoot)))
      || (profile.minutesEnabled !== undefined && typeof profile.minutesEnabled !== 'boolean') || (profile.minutesRoot !== undefined && (typeof profile.minutesRoot !== 'string' || !path.isAbsolute(profile.minutesRoot)))) || new Set(profiles.map(profile => profile.id)).size !== profiles.length)
      throw error('The vault profile registry is invalid. It was left unchanged.');
    for (const profile of profiles) {
      try { normalizeAutomaticLearningPolicy(profile.automaticLearning); }
      catch { throw error('The vault profile learning policy is invalid. It was left unchanged.'); }
      if (profile.learningRoot !== undefined && (typeof profile.learningRoot !== 'string' || !path.isAbsolute(profile.learningRoot)))
        throw error('The vault profile learning consent is invalid. It was left unchanged.');
    }
    return structuredClone(snapshot.profiles!);
  }
  private async roots(snapshot: Snapshot, stored = this.stored(snapshot)) {
    const data = await canonical(path.resolve(this.options.dataDirectory));
    const defaultId = snapshot.defaultProfile.id;
    const rows = [{ ...stored.profiles.find(profile => profile.id === defaultId), id: defaultId, name: stored.profiles.find(profile => profile.id === defaultId)?.name ?? snapshot.defaultProfile.name, vaultRoot: null },
      ...stored.profiles.filter(profile => profile.id !== defaultId)];
    for (const profile of rows) if (profile.id !== defaultId && !/^vp-[a-f0-9-]{36}$/.test(profile.id)) throw error('The vault profile registry contains an invalid id.');
    return Promise.all(rows.map(async profile => {
      const root = await canonical(profile.id === defaultId ? snapshot.defaultRoot : profile.vaultRoot ?? path.join(data, 'vaults', profile.id));
      const learning = normalizeAutomaticLearningPolicy(profile.automaticLearning);
      return { id: profile.id, name: profile.name,
      kind: profile.id === defaultId ? 'indexed' as const : profile.vaultRoot ? 'custom' as const : 'managed' as const,
      root,
      minutesEnabled: profile.minutesEnabled === false ? false : profile.id === defaultId
        ? profile.minutesEnabled === true && profile.minutesRoot === root || this.indexedOwned(snapshot, data, root)
        : profile.minutesEnabled ?? !profile.vaultRoot,
      automaticLearning: { enabled: learning.enabled, skills: learning.enabled && learning.skills,
        notes: learning.enabled && learning.notes && profile.learningRoot === root },
      workspaceIds: snapshot.workspaces.filter(workspace => workspace.profileId === profile.id).map(workspace => workspace.id),
    }; }));
  }
  private revision(snapshot: Snapshot): string {
    return createHash('sha256').update(JSON.stringify({ profiles: this.stored(snapshot), defaultProfile: snapshot.defaultProfile,
      root: snapshot.defaultRoot, workspaces: snapshot.workspaces.map(workspace => [workspace.id, workspace.profileId]).sort() })).digest('hex');
  }
  async list(): Promise<VaultProfilesCatalog> {
    const snapshot = this.options.read();
    return { revision: this.revision(snapshot), defaultProfileId: snapshot.defaultProfile.id, profiles: await this.roots(snapshot),
      workspaces: snapshot.workspaces.map(({ id, name, profileId }) => ({ id, name, profileId })) };
  }
  /** Existing Knowledge vault selection must preserve the one-vault-per-profile boundary too. */
  async assertDefaultRoot(root: string): Promise<void> {
    if (this.changing) throw error('Vault profiles are changing. Try again when they have finished.');
    if (!path.isAbsolute(root)) throw error('Enter the full path of the vault folder.');
    const snapshot = this.options.read();
    const candidate = await canonical(root);
    if ((await this.roots(snapshot)).some(profile => profile.id !== snapshot.defaultProfile.id && overlap(candidate, profile.root)))
      throw error('Each profile needs a separate vault folder; vault folders cannot overlap.');
  }
  async save(raw: SaveVaultProfileInput): Promise<VaultProfilesCatalog> {
    const input = normalizeSaveVaultProfile(raw);
    if (this.changing || this.options.busy()) throw error('Agent work or settings changes are active. Finish them before changing vault profiles.');
    this.changing = true;
    try {
      const snapshot = this.options.read();
      if (input.expectedRevision !== this.revision(snapshot)) throw error('Vault profiles or workspace bindings changed. Refresh before saving.');
      if (input.workspaceIds.some(id => !snapshot.workspaces.some(workspace => workspace.id === id))) throw error('A workspace no longer exists. Refresh before saving.');
      const stored = this.stored(snapshot);
      const id = input.id ?? `vp-${randomUUID()}`;
      const isDefault = id === snapshot.defaultProfile.id;
      if (input.id && !isDefault && !stored.profiles.some(profile => profile.id === id)) throw error('That vault profile no longer exists.');
      if (!input.id && stored.profiles.length >= 63) throw error('At most 64 vault profiles are supported.');
      if (isDefault && input.vaultRoot !== null) throw error('Change the indexed vault with the Knowledge vault setting.');
      let root: string | null = null;
      if (!isDefault && input.vaultRoot !== null) root = (await validateVaultRoot(input.vaultRoot, {
        dataDirectory: this.options.dataDirectory, homeDirectory: this.options.homeDirectory, profile: id,
      })).path;
      const previous = stored.profiles.find(profile => profile.id === id);
      const automaticLearning = input.automaticLearning ?? normalizeAutomaticLearningPolicy(previous?.automaticLearning);
      const learningRoot = input.automaticLearning === undefined ? previous?.learningRoot
        : automaticLearning.enabled && automaticLearning.notes
          ? await canonical(isDefault ? snapshot.defaultRoot : root ?? path.join(this.options.dataDirectory, 'vaults', id)) : undefined;
      const next = { id, name: input.name, vaultRoot: root, minutesEnabled: input.minutesEnabled, automaticLearning,
        ...(learningRoot !== undefined ? { learningRoot } : {}),
        ...(isDefault && input.minutesEnabled ? { minutesRoot: await canonical(snapshot.defaultRoot) } : {}) };
      const profiles = { profiles: [...stored.profiles.filter(profile => profile.id !== id), next] };
      const roots = await this.roots(snapshot, profiles);
      const candidate = roots.find(profile => profile.id === id)!;
      if (roots.some(profile => profile.id !== id && overlap(profile.root, candidate.root))) throw error('Each profile needs a separate vault folder; vault folders cannot overlap.');
      if (roots.some(profile => profile.id !== id && profile.name.toLowerCase() === input.name.toLowerCase())) throw error('Choose a distinct vault profile name.');
      // Removing a workspace from this profile returns it to the default; choosing one from another profile moves its binding.
      const workspaces = snapshot.workspaces.map(workspace => ({ ...workspace,
        profileId: input.workspaceIds.includes(workspace.id) ? id : workspace.profileId === id && !isDefault ? snapshot.defaultProfile.id : workspace.profileId,
      }));
      if (this.options.busy()) throw error('Agent work started. Finish it before changing vault profiles.');
      if (this.revision(this.options.read()) !== input.expectedRevision) throw error('Vault profiles changed. Refresh before saving.');
      await this.options.commit(profiles, workspaces);
      return await this.list();
    } finally { this.changing = false; }
  }

  /** Read effective policy without requiring a notes vault (including skills-only profiles). */
  async policyFor(workspaceId: string): Promise<{ profileId: string; revision: string; policy: AutomaticLearningPolicy }> {
    if (this.changing) throw error('Vault profiles are changing. Try again when they have finished.');
    const snapshot = this.options.read();
    const workspace = snapshot.workspaces.find(item => item.id === workspaceId);
    if (!workspace) throw error('That workspace no longer exists.');
    const stored = this.stored(snapshot).profiles.find(item => item.id === workspace.profileId);
    if (!stored && workspace.profileId !== snapshot.defaultProfile.id) throw error('That workspace has an unknown vault profile. Assign a registered profile in Settings.');
    if (stored && workspace.profileId !== snapshot.defaultProfile.id && !/^vp-[a-f0-9-]{36}$/.test(stored.id)) throw error('The vault profile registry contains an invalid id.');
    const learning = normalizeAutomaticLearningPolicy(stored?.automaticLearning);
    // A skills-only profile does not need filesystem access or a usable notes destination.
    const approvedNotes = learning.enabled && learning.notes && !!stored?.learningRoot
      && stored.learningRoot === await canonical(workspace.profileId === snapshot.defaultProfile.id ? snapshot.defaultRoot
        : stored.vaultRoot ?? path.join(this.options.dataDirectory, 'vaults', workspace.profileId));
    const policy = { enabled: learning.enabled, skills: learning.enabled && learning.skills, notes: approvedNotes };
    const revision = this.revision(snapshot);
    if (this.changing || this.revision(this.options.read()) !== revision) throw error('Vault profiles changed while reading the learning policy.');
    return { profileId: workspace.profileId, revision, policy };
  }

  /** Pin a validated root for one known workspace. Managed folders are created only when explicitly requested. */
  async resolve(workspaceId: string, { ensure = false, purpose = 'minutes' }: { ensure?: boolean; purpose?: 'minutes' | 'learning' } = {}): Promise<{ root: string; profileId: string; revision: string }> {
    if (purpose !== 'minutes' && purpose !== 'learning') throw error('Choose a supported vault purpose.');
    if (this.changing) throw error('Vault profiles are changing. Try again when they have finished.');
    const snapshot = this.options.read();
    const workspace = snapshot.workspaces.find(item => item.id === workspaceId);
    if (!workspace) throw error('That workspace no longer exists.');
    const profile = (await this.roots(snapshot)).find(item => item.id === workspace.profileId);
    if (!profile) throw error('That workspace has an unknown vault profile. Assign a registered profile in Settings.');
    if (purpose === 'learning' && !profile.automaticLearning.notes) throw error('Automatic learning notes are not enabled for this vault. Enable them in Settings before saving learning notes.');
    if (purpose === 'minutes' && !profile.minutesEnabled) throw error('Meeting minutes are not enabled for this vault. Enable them in Settings before exporting notes.');
    const data = await canonical(path.resolve(this.options.dataDirectory));
    const owned = path.join(data, 'vaults', profile.kind === 'indexed' ? 'default' : profile.id);
    let root: string;
    if (profile.kind === 'custom' || profile.kind === 'indexed' && !this.indexedOwned(snapshot, data, profile.root)) {
      const selected = profile.kind === 'indexed' ? snapshot.defaultRoot : this.stored(snapshot).profiles.find(item => item.id === profile.id)!.vaultRoot!;
      const check = await validateVaultRoot(selected, { dataDirectory: data, homeDirectory: this.options.homeDirectory, profile: profile.kind === 'indexed' ? 'default' : profile.id });
      root = check.path ?? owned;
      if (root !== path.resolve(selected)) throw error('The vault folder identity changed. Choose it again in Settings.');
    } else {
      const parent = path.join(data, 'vaults');
      if (ensure) {
        if (!this.options.ensureManagedRoot) throw error('The native learning backend is unavailable. No vault folder was created.');
        const actual = await this.options.ensureManagedRoot(profile.kind === 'indexed' ? 'default' : profile.id);
        if (!samePath(await canonical(actual), owned)) throw error('The native vault destination does not match this profile.');
      }
      for (const folder of [parent, owned]) {
        let info;
        try { info = await lstat(folder); }
        catch (failure) { if (!ensure && (failure as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failure; }
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw error('The managed vault folder is unavailable or has changed identity.');
      }
      root = owned;
    }
    const roots = await this.roots(snapshot);
    if (roots.some(other => other.id !== profile.id && overlap(root, other.root))) throw error('Vault folders overlap. Choose separate folders in Settings.');
    const revision = this.revision(snapshot);
    if (this.changing || this.revision(this.options.read()) !== revision) throw error('Vault profiles changed while resolving the workspace.');
    return { root, profileId: profile.id, revision };
  }
}
