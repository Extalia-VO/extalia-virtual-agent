import type { PortableMessage } from '@extalia/core';
import { useState } from 'react';
import { Markdown } from '../chat/Markdown';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

const LIMIT = 200;

function Collapsed({ t, message }: { t: Messages; message: PortableMessage }) {
  const [open, setOpen] = useState(false);
  const role = t.history.roles[message.role];
  const id = `library-message-${message.index}`;
  return (
    <div className="tool-card">
      <button type="button" className="disclosure flush" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chevron" />{open ? t.history.hideMessage : t.history.showMessage(role)}
      </button>
      {open && <pre className="tool-output" id={id} tabIndex={0}>{message.content}</pre>}
    </div>
  );
}

/** Read-only transcript of an imported conversation; tool and system messages start collapsed. */
export function LibraryTranscript({ t, messages }: { t: Messages; messages: readonly PortableMessage[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? messages : messages.slice(0, LIMIT);
  return (
    <>
      <ol className="transcript library-transcript">
        {shown.map(message => {
          switch (message.role) {
            case 'user':
              return <li key={message.index} className="msg user"><span className="visually-hidden">{t.history.roles.user}: </span><div className="bubble">{message.content}</div></li>;
            case 'assistant':
              return <li key={message.index} className="msg assistant"><span className="visually-hidden">{t.history.roles.assistant}: </span><Markdown text={message.content} /></li>;
            default:
              return <li key={message.index} className="msg"><Collapsed t={t} message={message} /></li>;
          }
        })}
      </ol>
      {!all && messages.length > LIMIT && <button type="button" className="button small" onClick={() => setAll(true)}>{t.history.showAll(messages.length)}</button>}
    </>
  );
}
