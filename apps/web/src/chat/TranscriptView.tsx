import type { ApprovalDecisionInput } from '@extalia/platform';
import type { ActivityKind } from '@extalia/protocol';
import { useState } from 'react';
import type { Messages } from '../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { Markdown } from './Markdown';
import type { ApprovalItem, ToolItem, TranscriptItem, UsageItem, WorkerItem } from './transcript';

const KIND_ICON: Record<ActivityKind, IconName> = {
  edit: 'edit', command: 'terminal', test: 'beaker', search: 'search', read: 'file', web: 'globe', delegate: 'users', knowledge: 'book', think: 'spark', tool: 'tool',
};

function ToolCard({ t, item }: { t: Messages; item: ToolItem }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const live = item.status === 'running' && Boolean(item.command);
  const open = expanded ?? live;
  const commandText = item.command?.output.map(chunk => chunk.text).join('') ?? '';
  const hasOutput = Boolean(item.command || item.output?.trim());
  const outputId = `output-${item.id}`;
  const showTarget = item.target && !item.label.includes(item.target);

  return (
    <div className={`tool-card status-${item.status}`}>
      <div className="tool-head">
        <span className="tool-icon" aria-hidden="true"><Icon name={KIND_ICON[item.activity] ?? 'tool'} /></span>
        <span className="tool-label">
          {item.label}
          {showTarget && <code className="tool-target">{item.target}</code>}
        </span>
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
      {hasOutput && (
        <>
          <button type="button" className="disclosure" aria-expanded={open} aria-controls={outputId} onClick={() => setExpanded(!open)}>
            <Icon name="chevron" />{open ? t.tool.hideOutput : t.tool.showOutput}
          </button>
          {open && (
            <pre className="tool-output" id={outputId} tabIndex={0}>
              {item.command && <span className="command-prompt">$ {item.command.command}{'\n'}</span>}
              {item.command
                ? item.command.output.map((chunk, index) => <span key={index} className={chunk.stream === 'stderr' ? 'stderr' : undefined}>{chunk.text}</span>)
                : item.output}
              {item.command && !commandText && item.status === 'running' && '…'}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function WorkerCard({ t, item }: { t: Messages; item: WorkerItem }) {
  const tier = item.tier && item.tier in t.connection.tiers ? t.connection.tiers[item.tier as keyof Messages['connection']['tiers']] : item.tier;
  const detail = item.status === 'running' ? item.activity ?? item.summary : item.summary ?? item.activity;
  return (
    <div className={`tool-card worker status-${item.status}`}>
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

export function TranscriptView({ t, items, language, onDecide }: {
  t: Messages;
  items: TranscriptItem[];
  language: string;
  onDecide: (approvalId: string, decision: ApprovalDecisionInput) => Promise<void>;
}) {
  return (
    <ol className="transcript">
      {items.map(item => {
        switch (item.kind) {
          case 'user':
            return <li key={item.id} className="msg user"><span className="visually-hidden">{t.chat.you}: </span><div className="bubble">{item.text}</div></li>;
          case 'assistant':
            return (
              <li key={item.id} className={`msg assistant ${item.streaming ? 'streaming' : ''}`} aria-busy={item.streaming || undefined}>
                <span className="visually-hidden">{t.chat.agent}: </span>
                <Markdown text={item.text} />
              </li>
            );
          case 'tool': return <li key={item.id} className="msg"><ToolCard t={t} item={item} /></li>;
          case 'worker': return <li key={item.id} className="msg worker-row"><WorkerCard t={t} item={item} /></li>;
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
        }
      })}
    </ol>
  );
}
