import type { AgentHostApi, ModelSelectionGuide, ModelSelectionGuideInput } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { useUnsavedDraft } from '../restart/unsavedDrafts';

const EMPTY: ModelSelectionGuideInput = { title: '', revision: '', text: '' };
export function validGuideDraft(draft: ModelSelectionGuideInput): boolean {
  return Boolean(draft.title.trim() && draft.title.length <= 120 && draft.revision.trim() && draft.revision.length <= 80 && draft.text.trim() && draft.text.length <= 24_000);
}

/** A profile-wide guide. It changes future plans only, never a team's saved choices. */
export function ModelGuidePanel({ agents, t, disabled = false, onPendingChange }: {
  agents: AgentHostApi; t: Messages; disabled?: boolean; onPendingChange?: (pending: boolean) => void;
}) {
  const c = t.modelGuide, id = useId();
  const [unsupported, setUnsupported] = useState(false);
  const supported = !unsupported && typeof agents.getModelSelectionGuide === 'function' && typeof agents.saveModelSelectionGuide === 'function';
  const scope = useMemo(() => ({ agents }), [agents]);
  const current = useRef(scope);
  const operation = useRef(0);
  useLayoutEffect(() => { current.current = scope; return () => { current.current = { ...scope }; }; }, [scope]);
  const [loaded, setLoaded] = useState<{ scope: typeof scope; guide: ModelSelectionGuide | null }>();
  const [draft, setDraft] = useState<ModelSelectionGuideInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) { setSeenScope(scope); setUnsupported(false); setLoaded(undefined); setDraft(EMPTY); setBusy(false); setFailure(undefined); setNotice(undefined); }
  const base = loaded?.scope === scope ? loaded.guide : undefined;
  const loading = supported && base === undefined && !failure;
  const dirty = base !== undefined && (draft.title !== (base?.title ?? '') || draft.revision !== (base?.revision ?? '') || draft.text !== (base?.text ?? ''));
  useUnsavedDraft(id, dirty);
  useEffect(() => { onPendingChange?.(dirty || busy || loading); }, [onPendingChange, dirty, busy, loading]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    void agents.getModelSelectionGuide!().then(guide => {
      if (!live) return;
      setLoaded({ scope, guide }); setDraft(guide ? { title: guide.title, revision: guide.revision, text: guide.text } : EMPTY);
    }, error => { if (live) { const message = errorMessage(error); if (/unknown (?:agent host )?method|not available on this host|not supported|does not support|not implemented/iu.test(message)) setUnsupported(true); else setFailure(message); } });
    return () => { live = false; };
  }, [agents, scope, supported, refresh]);

  async function save(clear = false) {
    if (!supported || disabled || busy || base === undefined || (!clear && !validGuideDraft(draft))) return;
    const owner = scope;
    setBusy(true); onPendingChange?.(true); setFailure(undefined); setNotice(undefined);
    try {
      const guide = await agents.saveModelSelectionGuide!(clear ? null : draft);
      if (current.current !== owner) return;
      setLoaded({ scope: owner, guide }); setDraft(guide ? { title: guide.title, revision: guide.revision, text: guide.text } : EMPTY);
      setNotice(clear ? c.removed : c.saved);
    } catch (error) { if (current.current === owner) setFailure(errorMessage(error)); }
    finally { if (current.current === owner) setBusy(false); }
  }

  return <details className="card model-guide-panel">
    <summary><Icon name="book" /> {c.title}</summary>
    <div className="form-stack">
      <p className="muted small">{c.hint}</p>
      {!supported ? <p className="note">{c.unavailable}</p> : <>
        {loading && <p role="status">{c.loading}</p>}
        {base !== undefined && <p className="note small" role="status">{base ? c.available(base.title, base.revision, base.updatedAt) : c.none}</p>}
        {base !== undefined && <>
          <div className="field"><label htmlFor={`${id}-title`}>{c.titleLabel}</label><input type="text" id={`${id}-title`} value={draft.title} disabled={disabled || busy} onChange={event => setDraft({ ...draft, title: event.target.value })} /></div>
          <div className="field"><label htmlFor={`${id}-revision`}>{c.revision}</label><input type="text" id={`${id}-revision`} value={draft.revision} disabled={disabled || busy} onChange={event => setDraft({ ...draft, revision: event.target.value })} /></div>
          <div className="field"><label htmlFor={`${id}-text`}>{c.content}</label><textarea id={`${id}-text`} rows={8} value={draft.text} placeholder={c.placeholder} disabled={disabled || busy} onChange={event => setDraft({ ...draft, text: event.target.value })} /></div>
          {dirty && <p className="note small">{validGuideDraft(draft) ? c.unsaved : c.limit}</p>}
          <div className="actions">
            <button type="button" disabled={disabled || busy} onClick={() => picker.current?.click()}>{c.importFile}</button>
            <input ref={picker} type="file" accept=".md,.txt,text/plain,text/markdown" hidden onChange={event => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (!file) return;
              if (file.size > 128 * 1024) { setFailure(c.importTooLarge); return; }
              const owner = scope, generation = ++operation.current;
              setBusy(true); onPendingChange?.(true);
              const owns = () => current.current === owner && generation === operation.current;
              void file.text().then(text => { if (owns()) { setDraft(value => ({ ...value, text })); setNotice(undefined); setFailure(undefined); } }, error => { if (owns()) setFailure(errorMessage(error)); }).finally(() => { if (owns()) setBusy(false); });
            }} />
            <button type="button" className="primary" disabled={disabled || busy || !dirty || !validGuideDraft(draft)} onClick={() => void save()}>{c.save}</button>
            <button type="button" disabled={disabled || busy || !base} onClick={() => void save(true)}>{c.clear}</button>
            {dirty && <button type="button" disabled={disabled || busy} onClick={() => { setDraft(base ? { title: base.title, revision: base.revision, text: base.text } : EMPTY); setFailure(undefined); setNotice(undefined); }}>{c.discard}</button>}
          </div>
        </>}
        {failure && <p role="alert" className="form-error">{c.failed} {failure} {base === undefined && <button type="button" onClick={() => { setFailure(undefined); setRefresh(value => value + 1); }}>{c.retry}</button>}</p>}
        {notice && <p role="status" className="note small">{notice}</p>}
      </>}
    </div>
  </details>;
}
