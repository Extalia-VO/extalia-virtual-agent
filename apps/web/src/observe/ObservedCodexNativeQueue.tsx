import { useId, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { QueuedPromptPreview } from '../chat/QueuedPromptPreview';
import { createCodexNativeQueueControl, type CodexNativeQueueControl, type CodexNativeQueueView } from './observedCodexNativeQueueModel';
import './observedCodexNativeQueue.css';

export interface ObservedCodexNativeQueueProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean }
export function ObservedCodexNativeQueue(props: ObservedCodexNativeQueueProps) {
  const observation = props.session.observation;
  if (props.session.control !== 'observed' || observation?.sourceId !== 'codex') return null;
  return <NativeQueueSession key={`${props.session.id}:${observation.sourceId}:${observation.nativeSessionId}`} {...props} />;
}
function NativeQueueSession({ t, agents, session, disabled }: ObservedCodexNativeQueueProps) {
  const nativeSessionId = session.observation!.nativeSessionId;
  const read = agents.observedCodexNativeQueueStatus;
  const control = useMemo(() => createCodexNativeQueueControl(agents, session.id, nativeSessionId),
    // A host may replace a capability without replacing the API object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, read, session.id, nativeSessionId]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const paused = !!disabled || !session.observation?.watching || session.observation.status !== 'watching';
  useLayoutEffect(() => { control.setDisabled(paused); }, [control, paused]);
  useLayoutEffect(() => {
    const visibility = () => control.setVisible(!document.hidden);
    visibility(); document.addEventListener('visibilitychange', visibility);
    const stop = control.start();
    return () => { document.removeEventListener('visibilitychange', visibility); stop(); };
  }, [control]);
  return <ObservedCodexNativeQueueContent t={t} control={control} view={view} disabled={paused} />;
}

export function ObservedCodexNativeQueueContent({ t, control, view, disabled = false }: {
  t: Messages; control: CodexNativeQueueControl; view: CodexNativeQueueView; disabled?: boolean;
}) {
  const c = t.observedCodexNativeQueue, id = useId();
  // Render-time masking prevents a previous snapshot flashing before layout cleanup.
  const phase = disabled ? 'paused' : view.phase;
  const status = phase === 'ready' ? view.status : undefined;
  const items = status?.items ?? [];
  if (phase === 'ready' && !items.length) return null;
  return <details className="observed-codex-native-queue">
    <summary>{c.title} <span>{phase === 'ready' ? c.count.replace('{count}', String(items.length)) : c.states[phase]}</span></summary>
    <div className="observed-codex-native-queue-body" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="observed-codex-native-queue-hint">{c.helper}</p>
      <div className="observed-codex-native-queue-toolbar">
        <p role="status">{phase === 'ready' ? items.length ? c.snapshot : c.empty : c.states[phase]}</p>
        {control.hasCapability && <button type="button" onClick={() => { void control.refresh(); }}
          disabled={disabled || phase === 'paused' || view.refreshing} aria-busy={view.refreshing}>{view.refreshing ? c.refreshing : c.refresh}</button>}
      </div>
      {status?.observedAt && <p className="observed-codex-native-queue-hint">{c.observedAt} <time dateTime={status.observedAt}>{status.observedAt}</time></p>}
      {!!items.length && <ol aria-label={c.items} tabIndex={0}>{items.map(item => <li key={item.id}>
        <QueuedPromptPreview t={t} text={item.text} attachments={item.attachments} />
        {item.nonTextItems > (item.attachments?.length ?? 0) && <p className="observed-codex-native-queue-hint">{c.nonText.replace('{count}', String(item.nonTextItems - (item.attachments?.length ?? 0)))}</p>}
        {!item.text && item.nonTextItems === 0 && <p className="observed-codex-native-queue-hint">{c.noText}</p>}
        {item.truncated && <p className="observed-codex-native-queue-hint">{c.itemTruncated}</p>}
      </li>)}</ol>}
      {status?.truncated && <p className="observed-codex-native-queue-hint">{c.truncated}</p>}
    </div>
  </details>;
}
