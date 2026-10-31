import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { CopyButton } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';
import { formatBytes, type AttachmentMetadata, type AttachmentPreviewLoader } from './attachments';
import { Markdown } from './Markdown';
import { presentUserMessage, type PresentedNotice } from './messagePresentation';
import type { UserItem } from './transcript';
import { useMessageFiles } from './MessageFilePreview';

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
  if (!message.text.trim() && !files.length && !message.questionReply) return null;
  const time = Date.parse(item.at);
  return <li className="msg user"><span className="visually-hidden">{t.chat.you}: </span>
    {!message.questionReply && message.text.trim() && <div className="message-actions">
      {Number.isFinite(time) && <time dateTime={item.at}>{new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(time)}</time>}
      <CopyButton text={message.text} label={t.chat.copyMessage} />
    </div>}
    <div className={`bubble${message.questionReply ? ' question-reply' : ''}`}>
    {files.length > 0 && <ul className="bubble-files" aria-label={t.composer.sentAttachments}>{files.map((file, index) => (
      file.kind === 'image' && file.ref && previewAttachment
        ? <AttachmentThumb key={index} t={t} file={file} ref_={file.ref} load={previewAttachment} />
        : <AttachmentRow key={index} file={file} />
    ))}</ul>}
    {message.questionReply ? <div className="question-answers">{message.questionReply.map((reply, index) => <div className="question-answer" key={index}>
      <div className="question-prompt"><span className="question-label">{t.chat.question}</span><Markdown text={reply.question} /></div>
      <div className="question-response"><span className="question-label"><Icon name="check" />{t.chat.yourAnswer}</span><Markdown text={reply.answer} /></div>
    </div>)}</div> : message.text && <FoldedText t={t} text={message.text} />}
  </div></li>;
}

/** An attached file listed by name, kind and size. */
function AttachmentRow({ file }: { file: AttachmentMetadata & { path?: string } }) {
  const openFile = useMessageFiles();
  const content = <><Icon name="file" /><span className="bubble-file-name">{file.name}</span>{file.size > 0 && <span className="bubble-file-size">{formatBytes(file.size)}</span>}</>;
  return <li className={`bubble-file kind-${file.kind}`}>{openFile
    ? <button type="button" className="message-file-chip" onClick={() => openFile({ name: file.name, path: file.path })}>{content}</button>
    : content}</li>;
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

