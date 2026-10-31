import { useState, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import type { ChangedFile } from './changedFiles';
import { useMessageFiles } from './MessageFilePreview';

function FileRow({ t, file, time }: { t: Messages; file: ChangedFile; time: Intl.DateTimeFormat }) {
  const openFile = useMessageFiles();
  const parts = file.path.split(/[\\/]/);
  const name = parts.at(-1) || file.path;
  const folder = parts.slice(0, -1).join('/');
  const content = <>
    <Icon name="file" />
    <span className="changed-file-path" title={file.path}><strong>{name}</strong>{folder && <small>{folder}</small>}</span>
    {file.edits > 1 && <span className="changed-file-edits">{t.characterConsole.fileEdits(file.edits)}</span>}
    <span className={`changed-file-kind ${file.change}`}>{t.tool.change[file.change]}</span>
    <time dateTime={file.lastAt}>{time.format(new Date(file.lastAt))}</time>
  </>;
  // A deleted file has nothing left to open.
  return <li>{openFile && file.change !== 'delete'
    ? <button type="button" className="changed-file" onClick={() => openFile({ name, path: file.path, link: true })}>{content}</button>
    : <span className="changed-file static">{content}</span>}</li>;
}

/** Every file the session changed, newest first; a row opens the file in the same preview as a link in a message. */
export function ChangedFilesView({ t, language, files }: { t: Messages; language: string; files: readonly ChangedFile[] }) {
  const c = t.characterConsole;
  const time = new Intl.DateTimeFormat(language, { timeStyle: 'short' });
  if (!files.length) return <p className="muted-note changed-files-empty">{c.noFiles}</p>;
  return <div className="changed-files">
    <p className="changed-files-summary">{c.filesSummary(files.length)}</p>
    <ul>{files.map(file => <FileRow key={file.path} t={t} file={file} time={time} />)}</ul>
  </div>;
}

/** Messages and Files over one conversation. Messages stay mounted, so switching keeps the scroll position. */
export function ConversationTabs({ t, language, files, children }: { t: Messages; language: string; files: readonly ChangedFile[]; children: ReactNode }) {
  const [tab, setTab] = useState<'messages' | 'files'>('messages');
  const c = t.characterConsole;
  return <>
    <div className="character-tabs conversation-tabs" role="tablist" aria-label={c.messages}>
      <button type="button" role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>{c.messages}</button>
      <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>{c.files}{files.length > 0 && <span className="badge">{files.length}</span>}</button>
    </div>
    <div className="conversation-panel" role="tabpanel" hidden={tab !== 'messages'}>{children}</div>
    {tab === 'files' && <div className="conversation-files" role="tabpanel"><ChangedFilesView t={t} language={language} files={files} /></div>}
  </>;
}
