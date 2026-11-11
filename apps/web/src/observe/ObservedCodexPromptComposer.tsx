import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { EFFORTS, type Effort } from '@extalia/core';
import type { AgentHostApi, ModelChoices, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { attachmentKind, formatBytes, planAttachments, uploadAttachments, type AttachmentHostApi, type PendingAttachment } from '../chat/attachments';
import { choiceFromValue, choiceValue, effortSelectOptions, modelSelectOptions } from '../chat/composerOptions';
import { PromptQueueContent } from '../chat/PromptQueueControls';
import { usePromptQueue } from '../chat/usePromptQueue';
import { useComposerDraft } from '../chat/useComposerDraft';
import { PromptDeliveryStatus } from '../chat/PromptDeliveryStatus';
import { observedSource } from '../office/agentOrigin';
import { ObservedCodexNativeQueue } from './ObservedCodexNativeQueue';
import { PromptSuggestions } from '../chat/PromptSuggestions';
import { CODEX_PROMPT_LIMIT, createObservedCodexPromptControl, supportsObservedPromptQueue, type ObservedCodexPromptControl, type ObservedCodexPromptView } from './observedCodexPromptModel';
import './observedCodex.css';

let observedChipSequence = 0;

export interface ObservedCodexPromptComposerProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean; showNativeQueue?: boolean }
export function ObservedCodexPromptComposer(props: ObservedCodexPromptComposerProps) {
  if (props.session.control !== 'observed' || !supportsObservedPromptQueue(props.session.observation?.sourceId)) return null;
  const key = `${props.session.id}:${props.session.observation.sourceId}:${props.session.observation.nativeSessionId}`;
  return <>{props.showNativeQueue !== false && props.session.observation.sourceId === 'codex' && <ObservedCodexNativeQueue key={`native:${key}`} {...props} />}
    {props.agents.promptQueueStatus && props.agents.changePromptQueue
      ? <QueuedPromptSession key={key} {...props} /> : <PromptSession key={key} {...props} />}
    <PromptSuggestions t={props.t} agents={props.agents} session={props.session} disabled={props.disabled} />
  </>;
}

/** One host-owned input keeps waiting prompts editable until their actual handoff. */
function QueuedPromptSession({ t, agents, session, disabled }: ObservedCodexPromptComposerProps) {
  const queue = usePromptQueue(agents, session, disabled);
  const draftState = useComposerDraft(agents, session);
  const { text: draft, setText: setDraft, sending } = draftState;
  const [chips, setChips] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [choices, setChoices] = useState<ModelChoices | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<Effort | undefined>(undefined);
  const chipsRef = useRef(chips);
  const files = useRef<HTMLInputElement>(null);
  const id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const sourceId = session.observation?.sourceId;
  const supportsModelPicker = supportsObservedPromptQueue(sourceId) && typeof agents.modelChoices === 'function';
  const activeChoices = supportsModelPicker ? choices : null;
  useEffect(() => {
    if (!supportsModelPicker || !agents.modelChoices) return;
    let active = true;
    void agents.modelChoices('', session.id)
      .then(result => { if (active) setChoices(result); })
      .catch(() => { if (active) setChoices(null); });
    return () => { active = false; };
  }, [agents, session.id, supportsModelPicker]);
  const pending = queue.view.status?.items.some(item => item.state === 'pending');
  const busySession = session.running || !!session.pendingApprovalId || pending;
  const locked = !!disabled || queue.view.disabled;
  const blocked = queue.view.status?.items.some(item => item.state === 'unknown');
  const retryBlocked = blocked || queue.view.status?.items.some(item => item.state === 'sending');
  const canAttach = !locked && !sending;
  const maxTextLength = queue.view.status?.maxTextLength ?? CODEX_PROMPT_LIMIT;
  const hasContent = !!draft.trim() || chips.length > 0;
  const canSend = !locked && !queue.locked && !sending && !queue.view.busy && !blocked && draftState.delivery !== 'unknown'
    && queue.view.delivery !== 'unknown' && queue.view.phase === 'ready' && !!queue.view.status?.supported
    && hasContent && !draft.includes('\0') && draft.length <= maxTextLength
    && !chips.some(chip => chip.status === 'uploading');
  useUnsavedDraft(id, !!draft.trim() || chips.length > 0);
  useLayoutEffect(() => { chipsRef.current = chips; }, [chips]);
  useEffect(() => () => { for (const chip of chipsRef.current) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl); }, []);
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [draft]);

  function patchChip(key: string, change: Partial<PendingAttachment>) {
    setChips(current => current.map(chip => (chip.key === key ? { ...chip, ...change } : chip)));
  }

  function addFiles(incoming: File[]) {
    if (!canAttach || incoming.length === 0) return;
    const plan = planAttachments(chipsRef.current.length, incoming);
    const messages = new Set<string>();
    for (const rejected of plan.rejected) {
      messages.add(rejected.rejection.reason === 'count'
        ? t.composer.tooMany
        : t.composer.tooLarge(rejected.name, formatBytes(rejected.rejection.limit)));
    }
    setNotice(messages.size ? [...messages].join(' ') : null);
    const added = plan.accepted.map((file): PendingAttachment => {
      const kind = attachmentKind(file.name, file.type);
      observedChipSequence += 1;
      return {
        key: `observed-chip-${observedChipSequence}`, file, name: file.name, mimeType: file.type, size: file.size, kind, status: 'ready',
        ...(kind === 'image' && typeof URL.createObjectURL === 'function' ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
    });
    if (added.length) setChips(current => [...current, ...added]);
  }

  function removeChip(chip: PendingAttachment) {
    setChips(current => current.filter(item => item.key !== chip.key));
    if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
    setNotice(null);
    if (chip.attachmentId && typeof agents.removeAttachment === 'function') {
      void agents.removeAttachment(session.id, chip.attachmentId).catch(() => undefined);
    }
  }

  async function buildSubmissionText(rawText: string, attached: PendingAttachment[]): Promise<string> {
    const parts: string[] = [];
    const headerTags: string[] = [];
    if (model) headerTags.push(`[Model: ${model}]`);
    if (effort) headerTags.push(`[Effort: ${t.composer.effortLabel[effort]}]`);
    if (headerTags.length > 0) parts.push(headerTags.join(' '));
    if (attached.length > 0) {
      const host = agents as AttachmentHostApi;
      if (typeof host.uploadAttachment === 'function') {
        await uploadAttachments(host, session.id, attached, patchChip);
      }
      for (const chip of attached) {
        const filePath = (chip.file as File & { path?: string }).path;
        if (filePath) {
          parts.push(`[Attached file: ${chip.name} (${filePath})]`);
        } else if (chip.kind === 'text' && typeof (agents as AttachmentHostApi).uploadAttachment !== 'function') {
          const textContent = await chip.file.text().catch(() => '');
          parts.push(textContent ? `[Attached file: ${chip.name}]\n${textContent.slice(0, 4000)}` : `[Attached file: ${chip.name}]`);
        } else {
          parts.push(`[Attached file: ${chip.name}]`);
        }
      }
    }
    if (rawText.trim()) parts.push(rawText.trim());
    return parts.join('\n\n').slice(0, maxTextLength);
  }

  async function send() {
    if (!canSend) return;
    const text = draft, attached = chips, lease = draftState.beginSend();
    if (!lease) return;
    setNotice(null);
    try {
      const composed = await buildSubmissionText(text, attached);
      const accepted = await queue.control.submit(composed);
      lease.finish(accepted ? 'accepted' : queue.control.getSnapshot().delivery === 'unknown' ? 'unknown' : 'failed');
      if (accepted) {
        for (const chip of chipsRef.current) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
        setChips([]);
      }
    } catch {
      lease.finish('failed');
      setNotice(t.composer.uploadFailed);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length) {
      if (!canAttach) return;
      event.preventDefault();
      addFiles(pasted);
    }
  }

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  function onDragOver(event: DragEvent<HTMLFormElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
    setDragging(canAttach);
  }
  function onDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }
  function onDrop(event: DragEvent<HTMLFormElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  const modelOptions = useMemo(() => {
    const availableModels = activeChoices?.models ?? (supportsModelPicker && session.model ? [session.model] : []);
    return availableModels.length > 0
      ? modelSelectOptions({ defaultModel: activeChoices?.defaultModel ?? session.model, models: availableModels, current: model ?? session.model }, {
        defaultLabel: value => t.composer.defaultModel(value),
      })
      : [];
  }, [activeChoices, model, session.model, supportsModelPicker, t.composer]);
  const effortOptions = effortSelectOptions({ efforts: EFFORTS }, {
    effort: (value: Effort) => t.composer.effortLabel[value],
    defaultLabel: label => t.composer.defaultEffort(label),
  });
  const originLabel = observedSource(session.observation?.sourceId).label || 'Codex';
  const withSource = (message: string) => originLabel !== 'Codex' ? message.replaceAll('Codex', originLabel) : message;
  const isCodex = session.observation?.sourceId === 'codex';
  const inputLabel = isCodex ? t.observedCodexPrompt.label : t.observedControl.message;
  const inputPlaceholder = busySession ? t.promptQueue.placeholder : (isCodex ? t.observedCodexPrompt.placeholder : t.observedControl.placeholder);
  const sendLabel = sending ? t.observedCodexPrompt.sending : busySession ? t.promptQueue.queueLabel : (isCodex ? t.observedCodexPrompt.send : t.observedControl.send);
  return <>
    {!!queue.view.status?.items.length && <PromptQueueContent t={t} control={queue.control} view={queue.view} disabled={locked} />}
    <PromptDeliveryStatus t={t} queueView={queue.view} phase={draftState.delivery} observed sourceLabel={originLabel}
      onRecheck={() => { void queue.control.refresh(); }} rechecking={queue.view.busy}
      onRetryConfirmed={draftState.delivery === 'unknown' && queue.view.phase === 'ready' && !retryBlocked ? () => {
        if (queue.control.allowRetry()) draftState.allowRetry();
      } : undefined} />
    <form className={`composer observed-codex-prompt has-toolbar ${dragging ? 'dragging' : ''}`} data-dragging={dragging || undefined}
      onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <label className="visually-hidden" htmlFor={`${id}-input`}>{inputLabel}</label>
      {chips.length > 0 && <ul className="composer-chips">
        {chips.map(chip => (
          <li key={chip.key} className={`composer-chip kind-${chip.kind} status-${chip.status}`}>
            {chip.previewUrl
              ? <img className="composer-chip-thumb" src={chip.previewUrl} alt="" />
              : <span className="composer-chip-icon" aria-hidden="true"><Icon name="file" /></span>}
            <span className="composer-chip-text">
              <span className="composer-chip-name" title={chip.name}>{chip.name}</span>
              <span className="composer-chip-meta" title={chip.status === 'failed' ? chip.error : undefined}>
                {chip.status === 'uploading' ? t.composer.uploading
                  : chip.status === 'failed' ? <><Icon name="alert" />{t.composer.uploadFailed}</>
                    : formatBytes(chip.size)}
              </span>
            </span>
            <button type="button" className="composer-chip-remove" disabled={sending} aria-label={`${t.composer.removeFile} ${chip.name}`} title={t.composer.removeFile}
              onClick={() => removeChip(chip)}>
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>}
      {notice && <p className="composer-notice" role="alert"><Icon name="alert" />{notice}</p>}
      <textarea ref={area} id={`${id}-input`} rows={2} value={draft} disabled={locked}
        placeholder={inputPlaceholder} autoComplete="off"
        onChange={event => setDraft(event.target.value)} onPaste={onPaste} onKeyDown={event => {
          if (!codexPromptEnterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
          event.preventDefault(); void send();
        }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      {dragging && <div className="composer-drop" aria-hidden="true">{t.composer.dropHint}</div>}
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button type="button" className="composer-attach" disabled={!canAttach} aria-label={t.composer.attach} title={`${t.composer.attach} · ${t.composer.attachHint}`}
            onClick={() => files.current?.click()}>
            <Icon name="paperclip" />
          </button>
          <input ref={files} type="file" multiple hidden tabIndex={-1} aria-hidden="true"
            onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        </div>
        <div className="composer-controls">
          {modelOptions.length > 0 && (
            <Select className="composer-picker composer-model" aria-label={t.composer.model}
              value={choiceValue(model)} options={modelOptions} disabled={locked || sending}
              placeholder={t.composer.defaultModel(activeChoices?.defaultModel ?? session.model)}
              onChange={value => setModel(choiceFromValue(value))} />
          )}
          <Select className="composer-picker composer-effort" aria-label={t.composer.effort}
            value={choiceValue(effort)} options={effortOptions} disabled={locked || sending} placeholder={t.composer.defaultEffort(undefined)}
            onChange={value => setEffort(choiceFromValue(value) as Effort | undefined)} />
          <button type="submit" className="send-button" disabled={!canSend} aria-busy={sending}
            aria-label={sendLabel}
            title={sendLabel}>
            <Icon name={sending ? 'refresh' : 'send'} className={sending ? 'spin' : ''} />
          </button>
        </div>
      </div>
      {(locked || queue.view.phase !== 'ready' || !queue.view.status?.supported || draft.length > CODEX_PROMPT_LIMIT) && <p role="status" className="observed-codex-prompt-hint">
        {locked ? t.observedCodexPrompt.paused : draft.length > CODEX_PROMPT_LIMIT ? withSource(t.observedCodexPrompt.tooLong)
          : queue.view.phase === 'loading' ? t.promptQueue.loading : queue.view.phase === 'error' ? t.promptQueue.failed : t.promptQueue.unsupported}
      </p>}
      {(queue.view.phase === 'error' || queue.view.notice) && queue.view.delivery !== 'unknown' && <p role="status">{queue.view.notice === 'stale' ? t.promptQueue.stale : t.promptQueue.failed}
        <button type="button" disabled={queue.view.busy} onClick={() => { void queue.control.refresh(); }}>{t.promptQueue.refresh}</button>
      </p>}
    </form>
  </>;
}
function PromptSession({ t, agents, session, disabled }: ObservedCodexPromptComposerProps) {
  const draft = useComposerDraft(agents, session);
  const nativeSessionId = session.observation?.nativeSessionId;
  const control = useMemo(() => createObservedCodexPromptControl(agents, session.id, nativeSessionId), [agents, session.id, nativeSessionId]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const paused = !!disabled || !session.observation?.watching || session.observation.status !== 'watching';
  useLayoutEffect(() => { control.setDisabled(paused); }, [control, paused]);
  useLayoutEffect(() => control.start(), [control]);
  return <ObservedCodexPromptContent t={t} control={control} view={view} disabled={paused} draft={draft} />;
}

export function codexPromptEnterSends(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function ObservedCodexPromptContent({ t, control, view, disabled = false, draft }: {
  t: Messages; control: ObservedCodexPromptControl; view: ObservedCodexPromptView; disabled?: boolean; draft?: ReturnType<typeof useComposerDraft>;
}) {
  const c = t.observedCodexPrompt, id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const locked = disabled || view.disabled || view.phase === 'unsupported';
  const text = draft?.text ?? view.draft, setText = draft?.setText ?? control.setDraft;
  const busy = !!draft?.sending || view.busy || !!view.status?.busy;
  useUnsavedDraft(id, text.trim().length > 0);
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [text]);
  const canSend = !locked && !busy && draft?.delivery !== 'unknown' && control.canSend(text);
  async function send() {
    if (!canSend) return;
    const lease = draft?.beginSend();
    if (draft && !lease) return;
    try { const result = await control.send(text); lease?.finish(result); }
    catch { lease?.finish('unknown'); }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!codexPromptEnterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
    event.preventDefault();
    if (canSend) void send();
  }
  const notice = view.notice === 'unknown' || view.status?.delivery === 'unknown' ? c.unknown
    : view.notice === 'queued' ? c.queued : view.notice === 'failed' || view.phase === 'error' ? c.failed
      : view.notice === 'unavailable' || view.phase === 'ready' && (!view.status?.threadId || view.status.enabled && !view.status.canQueue && !view.status.busy) ? c.unavailable
        : view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : undefined;
  const delivery = draft?.delivery === 'unknown' || view.notice === 'unknown' ? 'unknown'
    : busy ? 'submitting' : view.notice === 'queued' || view.status?.delivery === 'queued' ? 'accepted' : draft?.delivery;
  return <><PromptDeliveryStatus t={t} phase={delivery} observed onRecheck={() => { void control.refresh(); }} rechecking={busy}
    onRetryConfirmed={draft?.delivery === 'unknown' && control.canRetry() ? () => { if (control.allowRetry()) draft.allowRetry(); } : undefined} />
  <form className="composer observed-codex-prompt" onSubmit={event => { event.preventDefault(); if (canSend) void send(); }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}>
    <label className="visually-hidden" htmlFor={`${id}-input`}>{c.label}</label>
    <textarea ref={area} id={`${id}-input`} rows={2} value={text}
      placeholder={c.placeholder} disabled={locked} aria-describedby={`${id}-status`} autoComplete="off"
      onChange={event => setText(event.target.value)} onKeyDown={keyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    <button type="submit" className="send-button" disabled={!canSend} aria-label={busy ? c.sending : c.send} title={busy ? c.sending : c.send} aria-busy={busy}>
      <Icon name={busy ? 'refresh' : 'send'} className={busy ? 'spin' : ''} />
    </button>
    <p className="observed-codex-prompt-hint" id={`${id}-status`} role="status">{disabled || view.disabled ? c.paused
      : text.length > CODEX_PROMPT_LIMIT ? c.tooLong : delivery ? undefined : notice}</p>
    {view.phase === 'error' && <button type="button" disabled={view.busy || locked} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
  </form></>;
}
