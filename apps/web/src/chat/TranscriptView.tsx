import { sourceLabel } from '@extalia/core';
import type { ApprovalDecisionInput } from '@extalia/platform';
import type { ActivityKind } from '@extalia/protocol';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { formatBytes, type AttachmentMetadata, type AttachmentPreviewLoader } from './attachments';
import { Markdown } from './Markdown';
import type { ApprovalItem, ToolItem, TranscriptItem, UsageItem, WorkerItem } from './transcript';

const KIND_ICON: Record<ActivityKind, IconName> = {
  edit: 'edit', command: 'terminal', test: 'beaker', search: 'search', read: 'file', web: 'globe', delegate: 'users', knowledge: 'book', think: 'spark', tool: 'tool',
};

/** One tool call as a row of a run: icon, label, status; its output and changed files open below it. */
function ToolRow({ t, item }: { t: Messages; item: ToolItem }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const live = item.status === 'running' && Boolean(item.command);
  const open = expanded ?? live;
  const commandText = item.command?.output.map(chunk => chunk.text).join('') ?? '';
  const hasOutput = Boolean(item.command || item.output?.trim());
  const outputId = `output-${item.id}`;
  const showTarget = item.target && !item.label.includes(item.target);
  const label = <>
    <span className="tool-icon" aria-hidden="true"><Icon name={KIND_ICON[item.activity] ?? 'tool'} /></span>
    <span className="tool-label">
      {item.label}
      {showTarget && <code className="tool-target">{item.target}</code>}
      {hasOutput && <Icon name="chevron" className="tool-row-chevron" />}
    </span>
  </>;
  return (
    <li className={`tool-row status-${item.status}`}>
      <div className="tool-head">
        {hasOutput
          ? <button type="button" className="tool-row-toggle" aria-expanded={open} aria-controls={outputId}
              title={open ? t.tool.hideOutput : t.tool.showOutput} onClick={() => setExpanded(!open)}>{label}</button>
          : <span className="tool-row-toggle static">{label}</span>}
        {item.command?.exitCode !== undefined && (
          <span className="tool-meta">
            {t.tool.exit(item.command.exitCode)}
            {item.command.durationMs !== undefined && ` · ${t.tool.seconds((item.command.durationMs / 1000).toFixed(1))}`}
          </span>
        )}
        <span className={`tool-status ${item.status}`}>
          {item.status === 'running' ? <span className="pulse" aria-hidden="true" /> : <Icon name={item.status === 'ok' ? 'check' : item.status === 'failed' ? 'alert' : 'stop'} />}
          {t.tool.status[item.status]}
        </span>
      </div>
      {item.files.length > 0 && <FileList t={t} files={item.files} />}
      {hasOutput && open && (
        <pre className="tool-output" id={outputId} tabIndex={0}>
          {item.command && <span className="command-prompt">$ {item.command.command}{'\n'}</span>}
          {item.command
            ? item.command.output.map((chunk, index) => <span key={index} className={chunk.stream === 'stderr' ? 'stderr' : undefined}>{chunk.text}</span>)
            : item.output}
          {item.command && !commandText && item.status === 'running' && '…'}
        </pre>
      )}
    </li>
  );
}

type RunKind = keyof Messages['tool']['run'] & ('command' | 'read' | 'edit' | 'search' | 'web' | 'tool');
const RUN_KIND: Record<ActivityKind, RunKind> = {
  command: 'command', test: 'command', read: 'read', edit: 'edit', search: 'search', knowledge: 'search', web: 'web',
  delegate: 'tool', think: 'tool', tool: 'tool',
};

/** "Ran 4 commands and read 2 files": what a run of tool calls did, most common kinds first. */
export function toolRunSummary(t: Messages, items: readonly ToolItem[]): string {
  // Most frequent kinds first; equal counts keep the order they first happened in.
  const counts = new Map<RunKind, number>();
  for (const item of items) { const kind = RUN_KIND[item.activity] ?? 'tool'; counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const parts = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
    .map(kind => t.tool.run[kind](counts.get(kind)!));
  const text = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} ${t.tool.run.and} ${parts.at(-1)}` : parts.join(` ${t.tool.run.and} `);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Consecutive tool calls as one compact block: a summary line that folds the list, and one card with a
 * row per call. A run stays open while a call in it is running; a single call shows as its row alone.
 */
function ToolRun({ t, items }: { t: Messages; items: ToolItem[] }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const running = items.some(item => item.status === 'running');
  const failed = items.filter(item => item.status === 'failed').length;
  const open = items.length === 1 || (expanded ?? running);
  const listId = `run-${items[0]!.id}`;
  return (
    <div className={`tool-run ${failed ? 'has-failed' : ''}`}>
      {items.length > 1 && (
        <button type="button" className="tool-run-head" aria-expanded={open} aria-controls={listId} onClick={() => setExpanded(!open)}>
          <span>{toolRunSummary(t, items)}</span>
          {running && <span className="pulse" aria-hidden="true" />}
          {failed > 0 && <span className="tool-run-failed"><Icon name="alert" />{t.tool.run.failed(failed)}</span>}
          <Icon name="chevron" className="tool-run-chevron" />
        </button>
      )}
      {open && <ul className="tool-run-list" id={listId}>{items.map(item => <ToolRow key={item.id} t={t} item={item} />)}</ul>}
    </div>
  );
}

/** Consecutive workers (subagents) as one card with a row each. */
function WorkerRun({ t, items }: { t: Messages; items: WorkerItem[] }) {
  return <ul className="tool-run-list worker-run">{items.map(item => <li key={item.id} className="tool-row"><WorkerCard t={t} item={item} /></li>)}</ul>;
}

function WorkerCard({ t, item }: { t: Messages; item: WorkerItem }) {
  const tier = item.tier && item.tier in t.connection.tiers ? t.connection.tiers[item.tier as keyof Messages['connection']['tiers']] : item.tier;
  const detail = item.status === 'running' ? item.activity ?? item.summary : item.summary ?? item.activity;
  return (
    <div className={`worker status-${item.status}`}>
      <div className="tool-head">
        <span className="tool-icon" aria-hidden="true"><Icon name="users" /></span>
        <span className="tool-label">
          {tier && <span className="tier-badge">{tier}</span>}
          {item.label ?? t.tool.worker}
        </span>
        {item.toolCalls > 0 && <span className="tool-meta">{t.tool.workerCalls(item.toolCalls)}</span>}
        <span className={`tool-status ${item.status}`}>
          {item.status === 'running' ? <span className="pulse" aria-hidden="true" /> : <Icon name={item.status === 'ok' ? 'check' : item.status === 'failed' ? 'alert' : 'stop'} />}
          {t.tool.status[item.status]}
        </span>
      </div>
      {detail && <p className="worker-detail">{detail}</p>}
    </div>
  );
}

function FileList({ t, files }: { t: Messages; files: ToolItem['files'] }) {
  return (
    <ul className="file-list" aria-label={t.tool.changed}>
      {files.map(file => (
        <li key={file.path}><Icon name="file" /><code>{file.path}</code><span className={`file-change ${file.change}`}>{t.tool.change[file.change]}</span></li>
      ))}
    </ul>
  );
}

function ApprovalCard({ t, item, onDecide }: { t: Messages; item: ApprovalItem; onDecide: (approvalId: string, decision: ApprovalDecisionInput) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const decide = (decision: ApprovalDecisionInput) => {
    setBusy(true);
    onDecide(item.approvalId, decision).finally(() => setBusy(false));
  };
  const pending = item.status === 'pending';
  return (
    <div className={`approval-card ${item.status}`} role={pending ? 'group' : undefined} aria-label={pending ? t.approval.title : undefined}>
      <div className="approval-head">
        <Icon name="shield" />
        <strong>{pending ? t.approval.title : item.action}</strong>
        {item.risk && <span className={`risk ${item.risk}`}>{t.approval.risk[item.risk]}</span>}
        {!pending && (
          <span className={`approval-status ${item.status}`}>
            {item.status === 'granted' && item.by === 'policy' ? t.approval.byPolicy : t.approval.status[item.status as Exclude<ApprovalItem['status'], 'pending'>]}
          </span>
        )}
      </div>
      {pending && <p className="approval-action">{item.action}</p>}
      {item.detail && <p className="approval-detail">{item.detail}</p>}
      {pending && (
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => decide('once')}><Icon name="check" />{t.approval.allowOnce}</button>
          <button type="button" disabled={busy} onClick={() => decide('session')}>{t.approval.allowSession}</button>
          <button type="button" className="danger" disabled={busy} onClick={() => decide('reject')}><Icon name="close" />{t.approval.deny}</button>
        </div>
      )}
    </div>
  );
}

function UsageLine({ t, item, language }: { t: Messages; item: UsageItem; language: string }) {
  const format = new Intl.NumberFormat(language);
  const parts: string[] = [];
  if (item.usage && (item.usage.inputTokens !== undefined || item.usage.outputTokens !== undefined)) {
    parts.push(t.chat.usage(format.format(item.usage.inputTokens ?? 0), format.format(item.usage.outputTokens ?? 0)));
  }
  if (item.costUsd !== undefined) parts.push(t.chat.cost(item.costUsd.toFixed(item.costUsd < 0.1 ? 4 : 2)));
  if (item.model) parts.push(item.model);
  return <p className="usage-line">{parts.join(' · ')}</p>;
}

type Run = ToolItem[] | WorkerItem[];
/**
 * Consecutive tool calls as one run (it grows while the agent keeps calling tools and ends at its next
 * message), consecutive workers as another; every other item stays as it is.
 */
export function groupToolRuns(items: readonly TranscriptItem[]): (Exclude<TranscriptItem, ToolItem | WorkerItem> | Run)[] {
  const out: (Exclude<TranscriptItem, ToolItem | WorkerItem> | Run)[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === 'tool' || item.kind === 'worker') {
      if (Array.isArray(last) && last[0]!.kind === item.kind) (last as (ToolItem | WorkerItem)[]).push(item);
      else out.push([item] as Run);
    } else out.push(item);
  }
  return out;
}

/** An attached file listed by name, kind and size. */
function AttachmentRow({ file }: { file: AttachmentMetadata }) {
  return <li className={`bubble-file kind-${file.kind}`}><Icon name="file" /><span className="bubble-file-name">{file.name}</span>
    {file.size > 0 && <span className="bubble-file-size">{formatBytes(file.size)}</span>}</li>;
}

/** A small preview of an attached image the host kept a copy of; it opens full size and closes on a click or Escape. */
function AttachmentThumb({ t, file, ref_, load }: { t: Messages; file: AttachmentMetadata; ref_: string; load: AttachmentPreviewLoader }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void load(ref_).then(found => { if (live) setUrl(found ?? null); });
    return () => { live = false; };
  }, [load, ref_]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // No copy (yet): the file is listed like any other.
  if (url === null) return <AttachmentRow file={file} />;
  return <li className="bubble-thumb">
    <button type="button" className="bubble-thumb-button" title={file.name} aria-label={t.chat.openAttachment(file.name)} disabled={!url} onClick={() => setOpen(true)}>
      {url ? <img src={url} alt="" /> : <span className="bubble-thumb-loading" aria-hidden="true" />}
    </button>
    {/* Rendered on the page body: dialogs with transforms or blur would otherwise clip a fixed overlay. */}
    {open && url && typeof document !== 'undefined' && createPortal(<div className="attachment-viewer" role="dialog" aria-modal="true" aria-label={file.name} onClick={() => setOpen(false)}>
      <figure onClick={event => event.stopPropagation()}>
        <img src={url} alt={file.name} />
        <figcaption><span>{file.name}</span>{file.size > 0 && <span>{formatBytes(file.size)}</span>}
          <button type="button" className="icon-button small" aria-label={t.chat.closeAttachment} onClick={() => setOpen(false)}><Icon name="close" /></button></figcaption>
      </figure>
    </div>, document.body)}
  </li>;
}

export function TranscriptView({ t, items, language, onDecide, previewAttachment }: {
  t: Messages;
  items: TranscriptItem[];
  language: string;
  onDecide: (approvalId: string, decision: ApprovalDecisionInput) => Promise<void>;
  /** Loads images the host kept a copy of (observed transcripts); without it every file is listed. */
  previewAttachment?: AttachmentPreviewLoader | undefined;
}) {
  return (
    <ol className="transcript">
      {groupToolRuns(items).map(item => {
        if (Array.isArray(item)) {
          const run = item as Run;
          return run[0]!.kind === 'tool'
            ? <li key={run[0]!.id} className="msg"><ToolRun t={t} items={run as ToolItem[]} /></li>
            : <li key={run[0]!.id} className="msg worker-row"><WorkerRun t={t} items={run as WorkerItem[]} /></li>;
        }
        switch (item.kind) {
          case 'user':
            return <li key={item.id} className="msg user"><span className="visually-hidden">{t.chat.you}: </span><div className="bubble">
              {item.attachments && <ul className="bubble-files" aria-label={t.composer.sentAttachments}>{item.attachments.map((file, index) => (
                file.kind === 'image' && file.ref && previewAttachment
                  ? <AttachmentThumb key={index} t={t} file={file} ref_={file.ref} load={previewAttachment} />
                  : <AttachmentRow key={index} file={file} />
              ))}</ul>}
              {item.text}
            </div></li>;
          case 'assistant':
            return (
              <li key={item.id} className={`msg assistant ${item.streaming ? 'streaming' : ''}`} aria-busy={item.streaming || undefined}>
                <span className="visually-hidden">{t.chat.agent}: </span>
                <Markdown text={item.text} />
              </li>
            );
          case 'approval': return <li key={item.id} className="msg"><ApprovalCard t={t} item={item} onDecide={onDecide} /></li>;
          case 'files': return <li key={item.id} className="msg"><div className="tool-card status-ok"><FileList t={t} files={item.files} /></div></li>;
          case 'notice':
            return (
              <li key={item.id} className={`msg notice ${item.reason === 'cancelled' ? 'info' : 'error'}`}>
                <Icon name={item.reason === 'cancelled' ? 'stop' : 'alert'} />
                <span>{item.reason === 'cancelled' ? t.chat.stopped : `${item.reason === 'failed' ? t.chat.failed : t.chat.agentError} ${item.text ?? ''}`}</span>
              </li>
            );
          case 'usage': return <li key={item.id} className="msg"><UsageLine t={t} item={item} language={language} /></li>;
          case 'handoff':
            return (
              <li key={item.id} className={`msg handoff ${item.edge}`}>
                <span>{item.edge === 'start' ? t.handoff.carried(sourceLabel(item.runtime)) : t.handoff.here}</span>
              </li>
            );
        }
      })}
    </ol>
  );
}
