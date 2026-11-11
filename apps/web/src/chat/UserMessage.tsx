import { useState, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { CopyButton } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';
import { type AttachmentMetadata, type AttachmentPreviewLoader } from './attachments';
import { MessageAttachments } from './MessageAttachments';
import { Markdown } from './Markdown';
import { presentUserMessage, type PresentedNotice } from './messagePresentation';
import type { UserItem } from './transcript';

const COLLAPSE_CHARS = 900;
const COLLAPSE_LINES = 14;

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The small status mark of a task card: finished, failed or stopped at a glance. */
function statusIcon(status: PresentedNotice['status']) {
  return status === 'failed' ? 'alert' : status === 'stopped' ? 'stop' : 'check';
}

function Disclosure({ className, summary, children }: { className?: string; summary: ReactNode; children: ReactNode }) {
  return <li className="msg source-notice"><details className={`source-notice-card ${className ?? ''}`}>
    <summary>{summary}<Icon name="chevron" className="source-notice-chevron" /></summary>
    <div className="source-notice-body">{children}</div>
  </details></li>;
}

/** Text the agent app wrote into the user's turn, shown as a quiet status row rather than a message from the user. */
function SourceNotice({ t, notice, language }: { t: Messages; notice: PresentedNotice; language?: string | undefined }) {
  const raw = <details className="source-raw"><summary>{t.chat.sourceDetails}</summary><pre>{notice.raw}</pre></details>;
  switch (notice.kind) {
    case 'command':
      return <li className="msg user"><div className="bubble command-bubble"><code>{notice.summary}</code></div></li>;
    case 'shell':
      return <li className="msg source-notice"><div className="shell-card">
        <div className="shell-card-head"><Icon name="terminal" /><code>{notice.summary}</code></div>
        {notice.result && <pre className="shell-card-output" tabIndex={0}>{notice.result}</pre>}
      </div></li>;
    case 'output':
      return <Disclosure className="quiet" summary={<><Icon name="terminal" /><span className="source-notice-title">{t.chat.commandOutput}</span></>}>
        <pre className="shell-card-output" tabIndex={0}>{notice.summary}</pre>
      </Disclosure>;
    case 'system':
    case 'interrupted':
      return <Disclosure className="quiet" summary={<><Icon name={notice.kind === 'system' ? 'shield' : 'stop'} /><span className="source-notice-title">{notice.kind === 'system' ? t.chat.systemContext : t.chat.turnInterrupted}</span></>}>{raw}</Disclosure>;
    case 'context':
      return <Disclosure summary={<><Icon name="book" /><span className="source-notice-title">{t.chat.contextSummary}</span></>}>
        <Markdown text={notice.summary} />{raw}
      </Disclosure>;
    case 'task': {
      const format = new Intl.NumberFormat(language);
      const usage = [
        notice.usage?.tokens !== undefined ? t.chat.taskTokens(format.format(notice.usage.tokens)) : undefined,
        notice.usage?.toolUses !== undefined ? t.chat.taskToolUses(format.format(notice.usage.toolUses)) : undefined,
        notice.usage?.durationMs !== undefined ? formatDuration(notice.usage.durationMs) : undefined,
      ].filter(Boolean);
      return <Disclosure className={`task status-${notice.status}`} summary={<>
        <span className="source-notice-mark" aria-hidden="true"><Icon name={statusIcon(notice.status)} /></span>
        <span className="source-notice-title" title={notice.summary}>{notice.summary}</span>
        {notice.status && <span className={`badge status-${notice.status}`}>{t.chat.taskStatuses[notice.status]}</span>}
      </>}>
        <span className="visually-hidden">{t.chat.taskNotification}</span>
        {notice.result && <section className="source-task-result"><strong>{t.chat.taskResult}</strong><Markdown text={notice.result} /></section>}
        {usage.length > 0 && <p className="source-task-usage">{usage.join(' · ')}</p>}
        {raw}
      </Disclosure>;
    }
  }
}

/** A long prompt folds to a few lines, as chat apps do; it opens in place. */
function FoldedText({ t, text }: { t: Messages; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES;
  if (!long) return <Markdown text={text} />;
  return <>
    <div className={`bubble-fold ${open ? 'open' : ''}`}><Markdown text={text} /></div>
    <button type="button" className="bubble-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t.chat.showLess : t.chat.showMore}<Icon name="chevron" /></button>
  </>;
}

export function UserMessage({ t, item, previewAttachment, language }: { t: Messages; item: UserItem; previewAttachment?: AttachmentPreviewLoader | undefined; language?: string | undefined }) {
  const message = presentUserMessage(item.text);
  const text = message.questionReply?.map(reply => reply.answer).join('\n\n') ?? message.text;
  // Prefer the host's attachment reference/size. A textual local path never becomes an image URL.
  const files: (AttachmentMetadata & { path?: string })[] = [...(item.attachments ?? [])];
  const matched = new Set<number>();
  for (const file of message.attachments) {
    const index = files.findIndex((existing, at) => !matched.has(at) && existing.name === file.name);
    if (index >= 0) { files[index] = { ...files[index]!, path: file.path }; matched.add(index); }
    else { matched.add(files.length); files.push({ name: file.name, path: file.path, kind: file.image ? 'image' : 'file', size: 0 }); }
  }
  if (message.notice) return <SourceNotice t={t} notice={message.notice} language={language} />;
  // Only app metadata (e.g. an image note whose picture is listed with its prompt) has nothing to show.
  if (!text.trim() && !files.length) return null;
  const time = Date.parse(item.at);
  return <li className="msg user"><span className="visually-hidden">{t.chat.you}: </span>
    {text.trim() && <div className="message-actions">
      {Number.isFinite(time) && <time dateTime={item.at}>{new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(time)}</time>}
      <CopyButton text={text} label={t.chat.copyMessage} />
    </div>}
    <div className="bubble">
    <MessageAttachments t={t} files={files} load={previewAttachment} label={t.composer.sentAttachments} allowOpenFile />
    {text && <FoldedText t={t} text={text} />}
  </div></li>;
}

