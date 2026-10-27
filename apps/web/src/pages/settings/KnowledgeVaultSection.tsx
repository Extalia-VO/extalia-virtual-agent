import type { AgentHostApi, FileSystemCapability, KnowledgeVaultSettings } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { isUnsupportedMessage } from '../../knowledge/knowledgeModel';
import { Icon } from '../../ui/Icon';

type VaultApi = Required<Pick<AgentHostApi, 'knowledgeSettings' | 'setKnowledgeVaultRoot'>>;

/** Whether the host offers the vault setting (native core only; Desktop and the Bridge forward the names either way). */
export function vaultSettingsPresent(agents: Partial<AgentHostApi> | undefined): agents is Partial<AgentHostApi> & VaultApi {
  return typeof agents?.knowledgeSettings === 'function' && typeof agents.setKnowledgeVaultRoot === 'function';
}

/** The section as shown: current vault, safety note, default / choose actions. Pure, for tests. */
export function KnowledgeVaultView({ t, settings, busy, error, notice, canPick, path, onPath, onDefault, onChoose, onApply }: {
  t: Messages;
  settings: KnowledgeVaultSettings;
  busy: boolean;
  error?: string | undefined;
  notice?: string | undefined;
  /** Desktop: a native folder picker. Otherwise a path field. */
  canPick: boolean;
  path: string;
  onPath: (path: string) => void;
  onDefault: () => void;
  onChoose: () => void;
  onApply: () => void;
}) {
  const k = t.knowledgeVault;
  return (
    <section className="card settings-section" aria-labelledby="settings-knowledge-vault">
      <h2 id="settings-knowledge-vault">{k.title}</h2>
      <p className="muted">{k.lead}</p>
      <div className="command-line settings-data-folder" role="group" aria-label={k.current}>
        <span className="badge subtle">{settings.kind === 'custom' ? k.customKind : k.defaultKind}</span>
        <code>{settings.path ?? settings.label}</code>
      </div>
      {!settings.available && (
        <p className="form-error" role="alert"><Icon name="alert" />{settings.problem ? `${settings.problem} ` : ''}{k.unavailable}</p>
      )}
      {settings.obsidian && <p className="note"><Icon name="files" />{k.obsidian}</p>}
      <p className="muted small"><Icon name="shield" />{k.safety}</p>
      <p className="muted small">{k.watch[settings.watch]}</p>
      {canPick ? (
        <div className="actions">
          <button type="button" className="button small" disabled={busy} onClick={onChoose}><Icon name="folder" />{k.choose}</button>
          <button type="button" className="button small" disabled={busy || settings.kind === 'default'} onClick={onDefault}>{k.useDefault}</button>
        </div>
      ) : (
        <form className="actions" onSubmit={event => { event.preventDefault(); if (path.trim()) onApply(); }}>
          <label className="field">
            <span>{k.pathLabel}</span>
            <input type="text" value={path} placeholder={k.pathPlaceholder} spellCheck={false} autoComplete="off" maxLength={4096} onChange={event => onPath(event.target.value)} />
          </label>
          <button type="submit" className="button small" disabled={busy || !path.trim()}><Icon name="folder" />{k.apply}</button>
          <button type="button" className="button small" disabled={busy || settings.kind === 'default'} onClick={onDefault}>{k.useDefault}</button>
        </form>
      )}
      <p className="muted small">{k.busyHint}</p>
      {busy && <p className="muted small" role="status">{k.switching}</p>}
      {!busy && notice && <p className="muted small" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}

/** Settings → Knowledge vault. Hidden when the host does not offer the setting (TypeScript core). */
export function KnowledgeVaultSection({ t, agents, picker }: { t: Messages; agents: AgentHostApi; picker?: FileSystemCapability | undefined }) {
  const [settings, setSettings] = useState<KnowledgeVaultSettings | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [path, setPath] = useState('');
  const present = vaultSettingsPresent(agents);

  useEffect(() => {
    if (!vaultSettingsPresent(agents)) return;
    let active = true;
    agents.knowledgeSettings().then(
      value => { if (active) { setSettings(value); setPath(value.path ?? ''); } },
      failure => { if (!active) return; const message = errorMessage(failure); if (isUnsupportedMessage(message)) setHidden(true); else setError(message); },
    );
    return () => { active = false; };
  }, [agents]);

  if (!present || hidden) return null;
  if (!settings) {
    return error ? <section className="card settings-section"><h2>{t.knowledgeVault.title}</h2><p className="form-error" role="alert"><Icon name="alert" />{error}</p></section> : null;
  }
  const api = agents as AgentHostApi & VaultApi;

  const apply = async (root: string | null) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = await api.setKnowledgeVaultRoot(root);
      setSettings(next); setPath(next.path ?? '');
      setNotice(t.knowledgeVault.switched);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const choose = async () => {
    let selection;
    try { selection = await picker?.selectDirectory(); } catch (failure) { setError(errorMessage(failure)); return; }
    if (selection?.path) await apply(selection.path);
  };

  return (
    <KnowledgeVaultView t={t} settings={settings} busy={busy} error={error} notice={notice} canPick={Boolean(picker)} path={path} onPath={setPath}
      onDefault={() => void apply(null)} onChoose={() => void choose()} onApply={() => void apply(path.trim())} />
  );
}
