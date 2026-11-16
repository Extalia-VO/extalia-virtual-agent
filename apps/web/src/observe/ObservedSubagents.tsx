import { useRef } from 'react';
import { useObserveScroll } from './useObserveScroll';
import type { Messages } from '../i18n';
import { HistoricalMessageFileScope } from '../chat/MessageFilePreview';
import { MessageAttachments } from '../chat/MessageAttachments';
import type { AttachmentPreviewLoader } from '../chat/attachments';
import { TranscriptView } from '../chat/TranscriptView';
import type { TranscriptItem, WorkerItem } from '../chat/transcript';
import { Icon } from '../ui/Icon';
import './observedSubagents.css';

type ObservedWorker = Extract<TranscriptItem, { kind: 'worker' }>;
export interface ObservedSubagentRow { worker: ObservedWorker; depth: number; parentLabel?: string }

/** Display the actual delegation tree; retain invocation identity and source order. */
export function observedSubagentRows(items: readonly TranscriptItem[], depth = 0, parentLabel?: string): ObservedSubagentRow[] {
  const rows: ObservedSubagentRow[] = [];
  const seen = new Set<TranscriptItem>();
  const stack = items.map(worker => ({ worker, depth, parentLabel })).reverse();
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.worker.kind !== 'worker' || seen.has(entry.worker)) continue;
    seen.add(entry.worker);
    rows.push({ worker: entry.worker, depth: entry.depth, parentLabel: entry.parentLabel });
    const children = entry.worker.preview ?? [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ worker: children[index]!, depth: entry.depth + 1, parentLabel: entry.worker.label ?? entry.worker.subagentId });
  }
  return rows;
}

export function ObservedSubagentList({ t, rows, selectedWorkerId, onOpenWorker }: {
  t: Messages; rows: readonly ObservedSubagentRow[]; selectedWorkerId?: string; onOpenWorker: (worker: WorkerItem) => void;
}) {
  if (!rows.length) return null;
  const working = rows.filter(({ worker }) => worker.status === 'running');
  const finished = rows.filter(({ worker }) => worker.status !== 'running');
  const list = (group: readonly ObservedSubagentRow[]) => <ul className="observe-subagent-list">{group.map(({ worker, depth, parentLabel }) => <li key={worker.id}>
      <button type="button" className="observe-subagent-select" aria-pressed={selectedWorkerId === worker.id} onClick={() => onOpenWorker(worker)}>
        <Icon name="users" />
        <span className="observe-subagent-description"><span className="observe-subagent-name">{worker.label ?? worker.subagentId}</span>
          {depth > 0 && <span className="observe-subagent-parent">{t.observer.delegatedBy(parentLabel ?? '')}</span>}
          {(worker.activity || worker.summary || worker.task) && <span className="observe-subagent-activity">{worker.status === 'running' ? worker.activity ?? worker.summary ?? worker.task : worker.summary ?? worker.activity ?? worker.task}</span>}
        </span>
        <span className={`tool-status ${worker.status}`}>{worker.status === 'running' && <span className="pulse" aria-hidden="true" />}{t.tool.status[worker.status]}</span>
      </button>
    </li>)}</ul>;
  return <section className="observe-subagents" aria-label={t.observer.subagents}>
    <h3>{t.observer.subagents}<span className="badge">{rows.length}</span></h3>
    <div className="observe-subagent-groups">
      {!!working.length && <section className="observe-subagents-working" aria-label={t.observer.subagentsWorking}>
        <h4>{t.observer.subagentsWorking}<span className="badge">{working.length}</span></h4>
        {list(working)}
      </section>}
      {!!finished.length && <details className="observe-subagents-finished">
        <summary><Icon name="chevron" /><span>{t.observer.subagentsFinished}</span><span className="badge">{finished.length}</span></summary>
        {list(finished)}
      </details>}
    </div>
  </section>;
}

const ignoreDecision = async () => undefined;

export function ObservedSubagentPreview({ t, language, worker, onOpenWorker, previewAttachment }: {
  t: Messages; language: string; worker: ObservedWorker; onOpenWorker: (worker: WorkerItem) => void; previewAttachment?: AttachmentPreviewLoader;
}) {
  const label = worker.label ?? worker.subagentId;
  const region = useRef<HTMLDivElement>(null);
  useObserveScroll({ region, sessionKey: worker.id, contentReady: !!worker.preview?.length });
  return <section className="observe-subagent-preview" aria-label={t.tool.workerPreview(label)}>
    <header><h3>{label}</h3><span className={`tool-status ${worker.status}`}>{t.tool.status[worker.status]}</span></header>
    <p className="muted small">{t.tool.workerReadOnly}</p>
    {worker.task && <p className="observe-subagent-task" title={worker.task}><span>{t.tool.workerAssignment} </span>{worker.task}</p>}
    <div ref={region} className="observe-subagent-transcript" role="region" aria-label={t.tool.workerPreview(label)} tabIndex={0}>
      <HistoricalMessageFileScope scope={worker.fileScope}>
        <MessageAttachments t={t} files={worker.attachments ?? []} load={previewAttachment} label={t.tool.resultAttachments} className="tool-attachments" />
        {worker.preview?.length
          ? <TranscriptView key={worker.id} t={t} items={worker.preview} language={language} approvalsEnabled={false} onDecide={ignoreDecision} onOpenWorker={onOpenWorker} selectedWorkerId={worker.id} previewAttachment={previewAttachment} />
          : <p className="muted small" role="status">{t.observer.subagentNotReported}</p>}
      </HistoricalMessageFileScope>
    </div>
  </section>;
}
