import type { AgentHostApi, FileSystemCapability, KnowledgeVaultSettings, VaultProfile } from '@extalia/platform';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { isUnsupportedMessage } from '../../knowledge/knowledgeModel';
import { Icon } from '../../ui/Icon';
import { VaultProfilesSection } from './VaultProfilesSection';
import { HostFolderPicker } from '../../ui/HostFolderPicker';
import { CopyButton } from '../../ui/CopyButton';
import '../../knowledge/knowledgeContext.css';

type VaultApi = Required<Pick<AgentHostApi, 'knowledgeSettings' | 'setKnowledgeVaultRoot'>>;

/** Whether the host offers the vault setting (Desktop and the Bridge forward the names on older hosts too). */
export function vaultSettingsPresent(agents: Partial<AgentHostApi> | undefined): agents is Partial<AgentHostApi> & VaultApi {
  return typeof agents?.knowledgeSettings === 'function' && typeof agents.setKnowledgeVaultRoot === 'function';
}

/** The section as shown: current vault, safety note, default / choose actions. Pure, for tests. */
export function KnowledgeVaultView({ t, settings, busy, error, notice, onDefault, onChoose, folderControl, compact = false, policy }: {
  t: Messages;
  settings: KnowledgeVaultSettings;
  busy: boolean;
  error?: string | undefined;
  notice?: string | undefined;
  onDefault: () => void;
  onChoose: () => void;
  folderControl?: ReactNode;
  compact?: boolean | undefined;
  policy?: Pick<VaultProfile, 'minutesEnabled' | 'automaticLearning'> | undefined;
}) {
  const k = t.knowledgeVault;
  return (
    <section className={compact ? 'knowledge-vault-compact' : 'card settings-section'} aria-label={compact ? k.folderOptions : undefined} aria-labelledby={compact ? undefined : 'settings-knowledge-vault'}>
      {!compact && <><h2 id="settings-knowledge-vault">{k.title}</h2>
      <p className="muted">{k.lead}</p>
      <div className="knowledge-folder-location" role="group" aria-label={k.current}>
        <span className="badge subtle">{settings.kind === 'custom' ? k.customKind : k.defaultKind}</span>
        <code>{settings.path ?? settings.label}</code>
        <CopyButton text={settings.path ?? settings.label} label={k.current} />
      </div></>}
      {!settings.available && (
        <p className="form-error" role="alert"><Icon name="alert" />{settings.problem ? `${settings.problem} ` : ''}{k.unavailable}</p>
      )}
      {!compact && <>{settings.obsidian && <p className="note"><Icon name="files" />{k.obsidian}</p>}
      <p className="muted small"><Icon name="shield" />{k.safety}</p>
      <p className="muted small">{k.watch[settings.watch]}</p></>}
        <div className="actions">
          {folderControl ?? <button type="button" className="button small" disabled={busy} onClick={onChoose}><Icon name="folder" />{k.choose}</button>}
          <button type="button" className="button small" disabled={busy || settings.kind === 'default'} onClick={onDefault}>{compact ? k.useManaged : k.useDefault}</button>
        </div>
      {compact && <details className="knowledge-folder-behavior"><summary>{t.knowledgeContext.folderDetails}</summary>
        {settings.obsidian && <p className="muted small">{k.obsidian}</p>}
        <p className="muted small">{t.knowledgeContext.writeHint}</p>
        {policy && <dl className="knowledge-folder-policy">
          <div><dt>{t.knowledgeContext.minutes}</dt><dd>{policy.minutesEnabled ? t.knowledgeContext.allowed : t.knowledgeContext.off}</dd></div>
          <div><dt>{t.knowledgeContext.learning}</dt><dd>{policy.automaticLearning.enabled && policy.automaticLearning.notes ? t.knowledgeContext.allowed : t.knowledgeContext.off}</dd></div>
        </dl>}
        <p className="muted small"><Icon name="shield" />{k.safety}</p>
        <p className="muted small">{k.watch[settings.watch]}</p>
      </details>}
      <p className="muted small">{k.busyHint}</p>
      {busy && <p className="muted small" role="status">{k.switching}</p>}
      {!busy && notice && <p className="muted small" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}

/** Folder setup shared by Settings and Knowledge. Older hosts may lack this capability. */
type SectionProps = { t: Messages; agents: AgentHostApi; picker?: FileSystemCapability | undefined; onChanged?: (() => void) | undefined; locked?: boolean | undefined;
  compact?: boolean | undefined; showProfiles?: boolean | undefined; onBusyChange?: ((busy: boolean) => void) | undefined;
  policy?: Pick<VaultProfile, 'minutesEnabled' | 'automaticLearning'> | undefined };
export function KnowledgeVaultSection(props: SectionProps) {
  const [binding, setBinding] = useState({ agents: props.agents, key: 0 });
  if (binding.agents !== props.agents) setBinding({ agents: props.agents, key: binding.key + 1 });
  return <VaultSection key={binding.key} {...props} />;
}
function VaultSection({ t, agents, picker, onChanged, locked, compact, showProfiles = true, onBusyChange, policy }: SectionProps) {
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [settings, setSettings] = useState<KnowledgeVaultSettings | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const applying = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const present = vaultSettingsPresent(agents);
  useEffect(() => { onBusyChange?.(busy || choosing); return () => onBusyChange?.(false); }, [busy, choosing, onBusyChange]);

  useEffect(() => {
    if (!vaultSettingsPresent(agents)) return;
    let active = true;
    agents.knowledgeSettings().then(
      value => { if (active) setSettings(value); },
      failure => { if (!active) return; const message = errorMessage(failure); if (isUnsupportedMessage(message)) setHidden(true); else setError(message); },
    );
    return () => { active = false; };
  }, [agents, settingsRefresh]);

  if (!present || hidden) return null;
  if (!settings) {
    return <section className="card settings-section" aria-busy={!error || undefined}>
      <h2>{t.knowledgeVault.title}</h2>
      {error ? <><p className="form-error" role="alert"><Icon name="alert" />{error}</p>
        <button type="button" className="button small" onClick={() => { setError(undefined); setSettingsRefresh(value => value + 1); }}>{t.common.retry}</button></>
        : <p className="muted small" role="status">{t.common.loading}</p>}
    </section>;
  }
  const api = agents as AgentHostApi & VaultApi;

  const apply = async (root: string | null) => {
    if (applying.current || locked || !live.current) return;
    applying.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = await api.setKnowledgeVaultRoot(root);
      if (!live.current) return;
      setSettings(next);
      setProfileRefresh(value => value + 1);
      setNotice(t.knowledgeVault.switched); onChanged?.();
    } catch (failure) { if (live.current) setError(errorMessage(failure)); } finally { applying.current = false; if (live.current) setBusy(false); }
  };

  return (
    <><KnowledgeVaultView t={t} settings={settings} compact={compact} policy={policy} busy={busy || choosing || Boolean(locked)} error={error} notice={notice}
      onDefault={() => void apply(null)} onChoose={() => undefined} folderControl={<HostFolderPicker t={t} agents={agents} picker={picker} startPath={settings.path} disabled={busy || locked} onBusyChange={setChoosing} onSelect={apply} />} />
      {showProfiles && <details className="knowledge-profile-manager"><summary>{t.knowledgeVault.advancedProfiles}</summary>
        <VaultProfilesSection t={t} agents={agents} picker={picker} locked={busy || choosing || locked} changed={profileRefresh} />
      </details>}</>
  );
}
