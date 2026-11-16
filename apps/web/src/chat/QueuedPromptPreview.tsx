import { useMemo, useState } from 'react';
import type { ObservedCodexNativeQueueItem } from '@extalia/platform';
import { safeQueueThumbnail } from '@extalia/core';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Markdown } from './Markdown';
import { presentUserMessage } from './messagePresentation';
import './queuedPromptPreview.css';

type QueueAttachment = NonNullable<ObservedCodexNativeQueueItem['attachments']>[number];

function QueueThumbnail({ source, name }: { source: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <Icon name="file" /> : <img src={source} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

/** Display only: queue media never opens files, fetches remote images or starts prompts. */
export function QueuedPromptPreview({ t, text, attachments = [] }: {
  t: Messages; text: string; attachments?: readonly QueueAttachment[];
}) {
  const message = useMemo(() => presentUserMessage(text), [text]);
  const files = [...attachments];
  for (const file of message.attachments) {
    if (!files.some(existing => existing.name === file.name)) files.push({ kind: file.image ? 'image' : 'file', name: file.name });
  }
  const body = message.attachments.length ? message.text : text;
  return <div className="queued-prompt-preview">
    {files.length > 0 && <ul className="queued-prompt-attachments" aria-label={t.composer.sentAttachments}>
      {files.map((file, index) => {
        const name = file.name ?? t.promptQueue.attachmentKinds[file.kind];
        const thumbnail = file.kind === 'image' ? safeQueueThumbnail(file.thumbnail) : undefined;
        return <li className="queued-prompt-attachment" key={index}>
          {thumbnail ? <QueueThumbnail key={thumbnail} source={thumbnail} name={name} /> : <Icon name="file" />}
          <span>{name}</span>
        </li>;
      })}
    </ul>}
    {body && <Markdown text={body} allowFileLinks={false} />}
  </div>;
}
