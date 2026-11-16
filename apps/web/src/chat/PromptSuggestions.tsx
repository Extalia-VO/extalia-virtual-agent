import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, PromptSuggestionsStatus, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { CopyButton } from '../ui/CopyButton';
import { createPromptSuggestionsControl, fillPromptSuggestion, promptSuggestionsKey } from './promptSuggestionsModel';
import { useComposerDraft } from './useComposerDraft';
import './promptSuggestions.css';

export interface PromptSuggestionsProps { t: Messages; agents: AgentHostApi; session?: SessionSummary; workspaceId?: string; disabled?: boolean; copyOnly?: boolean }
export function PromptSuggestions({ t, agents, session, workspaceId, disabled = false, copyOnly = false }: PromptSuggestionsProps) {
  const key = session ? promptSuggestionsKey(session) : '';
  const control = useMemo(() => createPromptSuggestionsControl(agents, session?.id ?? '', key),
    // Optional method replacement is also a host capability change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, agents.promptSuggestions, agents.requestPromptSuggestions, key]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const draft = useComposerDraft(agents, session, workspaceId);
  const available = !!session && !disabled && !session.running && !session.pendingApprovalId
    && (session.control !== 'observed' || !!session.observation?.watching && session.observation.status === 'watching');
  useLayoutEffect(() => { control.setEnabled(available); }, [control, available]);
  useLayoutEffect(() => control.start(), [control]);
  if (!session || !available) return null;
  const locked = !!draft.text || draft.sending || draft.delivery === 'unknown';
  return <PromptSuggestionsContent t={t} status={view.status} locked={locked} copyOnly={copyOnly}
    onChoose={(prompt, button) => {
      if (copyOnly || !fillPromptSuggestion(agents, session, prompt)) return;
      const composer = button?.closest('.prompt-suggestions')?.previousElementSibling;
      if (composer?.matches('form.composer')) composer.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus();
    }} />;
}

export function PromptSuggestionsContent({ t, status, locked, copyOnly = false, onChoose }: {
  t: Messages; status?: PromptSuggestionsStatus; locked: boolean; copyOnly?: boolean; onChoose(prompt: string, button?: HTMLButtonElement): void;
}) {
  const c = t.promptSuggestions;
  if (!status || status.state !== 'pending' && (status.state !== 'ready' || !status.prompts.length)) return null;
  return <section className="prompt-suggestions" aria-label={c.title}>
    <div className="prompt-suggestions-meta">
      <span>{c.title}</span><span className="prompt-suggestions-origin">{status.origin === 'native' ? c.native : c.harness}</span>
    </div>
    {status.state === 'pending' ? <p className="prompt-suggestions-pending" role="status">{c.pending}</p>
      : <><ul>{status.prompts.map(prompt => <li key={prompt} className={copyOnly ? 'prompt-suggestions-copy' : undefined}>
        {copyOnly ? <><span>{prompt}</span><CopyButton text={prompt} label={prompt} /></>
          : <button type="button" disabled={locked} title={locked ? c.keepDraft : c.choose}
            onClick={event => { if (!locked) onChoose(prompt, event.currentTarget); }}>{prompt}</button>}
      </li>)}</ul><p className="prompt-suggestions-hint">{copyOnly ? c.copyHint : locked ? c.keepDraft : c.choose}</p></>}
  </section>;
}
