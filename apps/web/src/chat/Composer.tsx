import type { Effort } from '@extalia/core';
import type { AgentHostApi, ModelChoices, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { contextLabel } from '../office/overlay/contextLabel';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { Icon } from '../ui/Icon';
import { Select, type SelectOption } from '../ui/Select';
import { attachmentKind, formatBytes, planAttachments, type AttachmentHostApi, type PendingAttachment } from './attachments';
import {
  CONTEXT_RING_RADIUS, HERMES_CHOICE, choiceFromOptions, choiceFromValue, choiceValue, cleanChoice, contextRing, effortSelectOptions,
  isPermissionMode, modelSelectOptions, permissionSelectOptions, type PermissionMode, type SessionChoice,
} from './composerOptions';

/** What Send hands the host: the text, the attachments to upload first, and the choices for a session it creates. */
export interface ComposerSend {
  text: string;
  /** The model, effort and permission mode for a session this message creates; empty once one exists. */
  choice: SessionChoice;
  attachments: PendingAttachment[];
  /** Updates an attachment chip while its file uploads. */
  patch: (key: string, change: Partial<PendingAttachment>) => void;
  /** User-selected opt-in for this message only; never inferred from model content. */
  learnSkill?: boolean;
  /** Bind the first session this send creates before selecting it or uploading files. */
  bindSession?: (sessionId: string) => boolean;
}

type ChoicePatch = { [K in keyof SessionChoice]?: SessionChoice[K] | undefined };

let chipSequence = 0;

interface ComposerContext {
  agents: AgentHostApi;
  workspaceId: string;
  sessionId: string | undefined;
  hermes: boolean;
  readOnly: boolean;
  permissionValue: string;
}
const sameComposerScope = (left: ComposerContext, right: ComposerContext): boolean => left.agents === right.agents
  && left.workspaceId === right.workspaceId && left.hermes === right.hermes && left.readOnly === right.readOnly
  && left.permissionValue === right.permissionValue;

/** One send can follow its own newly created session, never navigation away and back. */
class ComposerSubmission {
  private accepted: ComposerContext;
  private targetId: string | undefined;
  private bound = false;
  private valid = true;
  constructor(readonly original: ComposerContext) { this.accepted = original; }
  bind(sessionId: string, current: ComposerContext): boolean {
    if (!this.owns(current) || this.original.sessionId !== undefined || this.bound || !sessionId.trim()) return false;
    this.bound = true; this.targetId = sessionId; return true;
  }
  observe(next: ComposerContext) {
    if (!this.valid || next === this.accepted) return;
    if (this.targetId && this.accepted === this.original && next.sessionId === this.targetId && sameComposerScope(this.original, next)) {
      this.accepted = next; this.targetId = undefined;
    } else this.valid = false;
  }
  owns(context: ComposerContext): boolean { return this.valid && this.accepted === context; }
}

/**
 * The message box of the chat page and the session dialog (v0.0.49), styled like Claude Code desktop:
 * a rounded card with the text on top and a toolbar below. Left: attach files (picker, drop, paste; up to 10).
 * Right: permission mode, model and effort, the context ring and Send. Enter sends, Shift+Enter adds a line.
 * The choices apply to the session at once (`setSessionOptions`); before the first message they travel with it.
 */
export function Composer({ t, agents, session, workspaceId, hermes, running, waiting, readOnly, stopping, onSend, onStop, onSessionChanged }: {
  t: Messages;
  agents: AgentHostApi;
  /** The session the message goes to; absent on the Chat page before its first message. */
  session?: SessionSummary | undefined;
  workspaceId: string;
  /** A Hermes workspace or session: Hermes manages the permissions, so the picker only says so. */
  hermes: boolean;
  running: boolean;
  /** An approval card needs an answer first. */
  waiting: boolean;
  readOnly: boolean;
  stopping: boolean;
  onSend: (request: ComposerSend) => Promise<boolean>;
  onStop: () => void;
  /** After a choice was saved, so the host state (and the session's options) reload. */
  onSessionChanged?: (() => void) | undefined;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [chips, setChips] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<SessionChoice>({});
  // A pending choice belongs to the session it was made for; a new session state drops it.
  const [pending, setPending] = useState<{ base: SessionSummary | undefined; choice: SessionChoice }>();
  // The workspace's models and efforts, kept with the workspace they came for.
  const [loaded, setLoaded] = useState<{ workspaceId: string; choices: ModelChoices }>();
  const optimistic = pending && pending.base === session ? pending.choice : undefined;
  const choices = loaded && loaded.workspaceId === workspaceId ? loaded.choices : undefined;
  const area = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const chipsRef = useRef(chips);
  // Typed but unsent text (or files) would be lost by a restart, so the restart prompt asks first. Each instance has its own owner.
  const draftOwner = useId();
  useUnsavedDraft(draftOwner, text.trim().length > 0 || chips.length > 0);

  const host: AttachmentHostApi = agents;
  const sessionId = session?.id;
  const attachmentsSupported = typeof host.uploadAttachment === 'function';
  const disabled = readOnly || waiting;
  const canAttach = attachmentsSupported && !disabled && !running && !sending && !readOnly;
  const pickersEnabled = !readOnly && !running && !sending;
  const canSend = !disabled && !running && !sending && (text.trim().length > 0 || chips.length > 0)
    && !chips.some(chip => chip.status === 'uploading');

  useLayoutEffect(() => { chipsRef.current = chips; }, [chips]);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);
  // Free the thumbnails when the composer goes away.
  useEffect(() => () => { for (const chip of chipsRef.current) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl); }, []);

  useEffect(() => {
    let current = true;
    agents.modelChoices(workspaceId)
      .then(next => { if (current) setLoaded({ workspaceId, choices: next }); })
      .catch(() => { if (current) setLoaded(undefined); });
    return () => { current = false; };
  }, [agents, workspaceId]);

  // The choices shown: the session's own, or the draft that the first message will create the session with.
  const shown: SessionChoice = optimistic ?? (session ? choiceFromOptions(session.options) : draft);

  async function changeChoice(patch: ChoicePatch) {
    const next = cleanChoice({ ...shown, ...patch });
    setPickerError(null);
    if (!sessionId) { setDraft(next); return; }
    const previous = shown;
    setPending({ base: session, choice: next });
    try {
      await agents.setSessionOptions(sessionId, next);
      onSessionChanged?.();
    } catch (failure) {
      setPending({ base: session, choice: previous });
      setPickerError(errorMessage(failure) || t.composer.pickerFailed);
    }
  }

  const modeLabels = {
    label: (mode: PermissionMode) => t.composer.mode[mode].label,
    description: (mode: PermissionMode) => t.composer.mode[mode].description,
    managed: t.composer.mode.managed,
  };
  const permissionOptions = permissionSelectOptions(hermes ? 'hermes' : 'extalia-native', modeLabels, { modes: choices?.permissionModes, current: shown.permissionMode });
  const permissionValue = hermes ? HERMES_CHOICE : (shown.permissionMode ?? 'workspace');
  const learningContext = useMemo(() => ({ agents, workspaceId, sessionId, hermes, readOnly, permissionValue }), [agents, workspaceId, sessionId, hermes, readOnly, permissionValue]);
  const [learning, setLearning] = useState(() => ({ context: learningContext, selected: false }));
  const [sessionBinding, setSessionBinding] = useState<{ from: ComposerContext; sessionId: string }>();
  // Reset on context replacement, including a switch away and back while a send is pending.
  if (learning.context !== learningContext) {
    const ownCreatedSession = sessionBinding?.from === learning.context && sessionBinding.sessionId === sessionId
      && sameComposerScope(sessionBinding.from, learningContext);
    setLearning({ context: learningContext, selected: Boolean(ownCreatedSession && learning.selected) });
  }
  const currentLearningContext = useRef(learningContext);
  const submission = useRef<ComposerSubmission | undefined>(undefined);
  useLayoutEffect(() => {
    currentLearningContext.current = learningContext;
    submission.current?.observe(learningContext);
  }, [learningContext]);
  const canLearn = !hermes && !readOnly && permissionValue !== 'plan';
  const learnSkill = canLearn && learning.context === learningContext && learning.selected;
  const modelOptions: SelectOption[] = choices
    ? modelSelectOptions({ defaultModel: choices.defaultModel, models: choices.models, current: shown.model }, {
      defaultLabel: model => t.composer.defaultModel(model),
    })
    : [];
  const effortOptions: SelectOption[] = choices
    ? effortSelectOptions({ efforts: choices.efforts, defaultEffort: choices.defaultEffort }, {
      effort: (value: Effort) => t.composer.effortLabel[value],
      defaultLabel: effort => t.composer.defaultEffort(effort),
    })
    : [];
  const defaultModelLabel = t.composer.defaultModel(choices?.defaultModel);
  const defaultEffortLabel = t.composer.defaultEffort(choices?.defaultEffort ? t.composer.effortLabel[choices.defaultEffort] : undefined);

  const ring = contextRing(session?.context);
  const ringLabel = session?.context && ring ? (() => {
    const label = contextLabel(session.context, t);
    return `${t.composer.context(label.value)}${label.title ? `\n${label.title}` : ''}`;
  })() : undefined;

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
      chipSequence += 1;
      return {
        key: `chip-${chipSequence}`, file, name: file.name, mimeType: file.type, size: file.size, kind, status: 'ready',
        ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
    });
    if (added.length) setChips(current => [...current, ...added]);
  }

  function removeChip(chip: PendingAttachment) {
    setChips(current => current.filter(item => item.key !== chip.key));
    if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
    setNotice(null);
    // An uploaded file no longer needed goes back out of the session's store (best effort).
    if (chip.attachmentId && sessionId && host.removeAttachment) void host.removeAttachment(sessionId, chip.attachmentId).catch(() => undefined);
  }

  async function send() {
    if (!canSend) return;
    const prompt = text.trim();
    const sent = chips;
    const sentContext = learningContext;
    const owner = new ComposerSubmission(sentContext);
    submission.current = owner;
    setSending(true);
    setText('');
    setNotice(null);
    const choice = cleanChoice(hermes ? { ...draft, permissionMode: undefined } : draft);
    const ok = await onSend({ text: prompt, choice, attachments: sent,
      patch: (key, change) => { if (owner.owns(currentLearningContext.current)) patchChip(key, change); },
      bindSession: id => {
        if (!owner.bind(id, currentLearningContext.current)) return false;
        setSessionBinding({ from: sentContext, sessionId: id }); return true;
      },
      ...(learnSkill ? { learnSkill: true } : {}),
    }).catch(() => false);
    if (submission.current === owner) submission.current = undefined;
    if (!owner.owns(currentLearningContext.current)) {
      // A navigated-away send may consume its files; it cannot restore old input
      // or learning choices over the new context, even if the user navigates back.
      if (ok) {
        const sentKeys = new Set(sent.map(chip => chip.key));
        for (const chip of chipsRef.current) if (sentKeys.has(chip.key) && chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
        setChips(current => current.filter(chip => !sentKeys.has(chip.key)));
      }
      setSending(false); return;
    }
    if (ok) {
      for (const chip of chipsRef.current) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
      setChips([]);
      setLearning(current => owner.owns(current.context) ? { ...current, selected: false } : current);
    } else {
      // Keep what the user wrote when the host refused it; attachments stay so a retry reuses uploaded ones.
      setText(current => current || prompt);
    }
    setSending(false);
    area.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length === 0 || !canAttach) return;
    // Files are attached; any text pasted alongside them stays out of the message.
    event.preventDefault();
    addFiles(pasted);
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
    // Always take the drop here, so the browser never opens the file in place of the chat.
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  const placeholder = readOnly ? t.chat.placeholderObserved : waiting ? t.chat.placeholderWaiting : t.chat.placeholder;
  const alertText = notice ?? pickerError;
  return (
    <form className={`composer ${dragging ? 'dragging' : ''}`} data-dragging={dragging || undefined}
      onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <label className="visually-hidden" htmlFor="composer-input">{t.chat.composer}</label>
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
      {alertText && <p className="composer-notice" role="alert"><Icon name="alert" />{alertText}</p>}
      <textarea id="composer-input" ref={area} rows={1} value={text} placeholder={placeholder} disabled={disabled} aria-describedby="composer-hint"
        title={t.chat.hint} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
      {dragging && <div className="composer-drop" aria-hidden="true">{t.composer.dropHint}</div>}
      {canLearn && <label className="check-row small">
        <input type="checkbox" checked={learnSkill} disabled={!pickersEnabled || waiting}
          onChange={event => setLearning({ context: learningContext, selected: event.target.checked })} />
        <span>{t.composer.learnSkill}</span>
      </label>}
      {learnSkill && <p className="note small" role="note">{t.composer.learnSkillHint}</p>}
      <div className="composer-toolbar">
        <div className="composer-tools">
          {attachmentsSupported && <>
            <button type="button" className="composer-attach" disabled={!canAttach} aria-label={t.composer.attach} title={`${t.composer.attach} · ${t.composer.attachHint}`}
              onClick={() => files.current?.click()}>
              <Icon name="paperclip" />
            </button>
            <input ref={files} type="file" multiple hidden tabIndex={-1} aria-hidden="true"
              onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          </>}
        </div>
        <div className="composer-controls">
          {!readOnly && <Select className="composer-picker composer-permission" aria-label={t.composer.permission} value={permissionValue}
            options={permissionOptions} disabled={!pickersEnabled || hermes} placeholder={t.composer.mode.workspace.label}
            onChange={value => { if (isPermissionMode(value)) void changeChoice({ permissionMode: value }); }} />}
          {!readOnly && choices && <Select className="composer-picker composer-model" aria-label={t.composer.model} value={choiceValue(shown.model)}
            options={modelOptions} disabled={!pickersEnabled} placeholder={defaultModelLabel}
            onChange={value => void changeChoice({ model: choiceFromValue(value) })} />}
          {!readOnly && choices && effortOptions.length > 0 && <Select className="composer-picker composer-effort" aria-label={t.composer.effort}
            value={choiceValue(shown.effort)} options={effortOptions} disabled={!pickersEnabled} placeholder={defaultEffortLabel}
            onChange={value => void changeChoice({ effort: choiceFromValue(value) as Effort | undefined })} />}
          {ring && ringLabel && <span className={`composer-ring tone-${ring.tone}`} role="img" aria-label={ringLabel} title={ringLabel}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <circle className="composer-ring-track" cx="12" cy="12" r={CONTEXT_RING_RADIUS} fill="none" strokeWidth="2.6" />
              <circle className="composer-ring-arc" cx="12" cy="12" r={CONTEXT_RING_RADIUS} fill="none" strokeWidth="2.6" strokeLinecap="round"
                strokeDasharray={`${ring.dash} ${ring.circumference}`} transform="rotate(-90 12 12)" />
            </svg>
          </span>}
          {running ? (
            <button type="button" className="send-button stop" disabled={stopping || readOnly} onClick={onStop} aria-label={t.chat.stop} title={t.chat.stop}>
              <Icon name="stop" />
            </button>
          ) : (
            <button type="submit" className="send-button" disabled={!canSend} aria-label={t.chat.send} title={t.chat.send}>
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      <small id="composer-hint" className="visually-hidden">{t.chat.hint}</small>
    </form>
  );
}
