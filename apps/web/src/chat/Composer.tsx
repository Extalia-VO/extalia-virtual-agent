import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

/** Prompt input: grows with its text, Enter sends, Shift+Enter adds a line; the button turns into Stop while a turn runs. */
export function Composer({ t, running, waiting, readOnly, stopping, onSend, onStop }: {
  t: Messages;
  running: boolean;
  /** An approval card needs an answer first. */
  waiting: boolean;
  readOnly: boolean;
  stopping: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  const disabled = readOnly || waiting;
  const canSend = !disabled && !running && !sending && text.trim().length > 0;

  async function send() {
    if (!canSend) return;
    const prompt = text.trim();
    setSending(true);
    setText('');
    const ok = await onSend(prompt);
    // Keep what the user wrote when the host refused it.
    if (!ok) setText(current => current || prompt);
    setSending(false);
    area.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  const placeholder = readOnly ? t.chat.placeholderObserved : waiting ? t.chat.placeholderWaiting : t.chat.placeholder;
  return (
    <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="visually-hidden" htmlFor="composer-input">{t.chat.composer}</label>
      <textarea id="composer-input" ref={area} rows={1} value={text} placeholder={placeholder} disabled={disabled} aria-describedby="composer-hint"
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      {running ? (
        <button type="button" className="send-button stop" disabled={stopping || readOnly} onClick={onStop} aria-label={t.chat.stop} title={t.chat.stop}>
          <Icon name="stop" />
        </button>
      ) : (
        <button type="submit" className="send-button" disabled={!canSend} aria-label={t.chat.send} title={t.chat.send}>
          <Icon name="send" />
        </button>
      )}
      <small id="composer-hint" className="composer-hint">{t.chat.hint}</small>
    </form>
  );
}
