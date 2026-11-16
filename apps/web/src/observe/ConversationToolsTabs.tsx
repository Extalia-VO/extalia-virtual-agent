import { useId, useState, type ReactNode } from 'react';
import './conversationToolsTabs.css';

export interface ConversationToolTab { id: string; label: string; render: (active: boolean) => ReactNode }

/** Keep tool forms mounted so switching tabs preserves pending answers and settings drafts. */
export function ConversationToolsTabs({ label, items }: { label: string; items: ConversationToolTab[] }) {
  const id = useId(), [chosen, setChosen] = useState<string>();
  if (!items.length) return null;
  if (items.length === 1) return <>{items[0]!.render(true)}</>;
  const selected = items.findIndex(item => item.id === chosen), active = Math.max(0, selected);
  return <div className="conversation-tools-tabs">
    <div role="tablist" aria-label={label}>
      {items.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}-tab`}
        aria-controls={`${id}-${item.id}-panel`} aria-selected={index === active} tabIndex={index === active ? 0 : -1}
        onClick={() => setChosen(item.id)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
          setChosen(items[next]!.id); document.getElementById(`${id}-${items[next]!.id}-tab`)?.focus();
        }}>{item.label}</button>)}
    </div>
    {items.map((item, index) => <div key={item.id} id={`${id}-${item.id}-panel`} role="tabpanel" aria-labelledby={`${id}-${item.id}-tab`}
      hidden={index !== active} inert={index !== active || undefined}>{item.render(index === active)}</div>)}
  </div>;
}
