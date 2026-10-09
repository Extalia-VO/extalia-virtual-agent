import { useEffect, useState } from 'react';
import { useMessages } from './messages';
import { Icon } from './Icon';

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Older WebViews: fall back to a temporary selection.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try { document.execCommand('copy'); } finally { area.remove(); }
}

/** Copies text and confirms it in place; the label names what is copied for screen readers. */
export function CopyButton({ text, label, className = '' }: { text: string; label?: string; className?: string }) {
  const t = useMessages();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button type="button" className={`copy-button ${className}`} aria-label={label ? t.common.copyLabel(label) : t.common.copy} onClick={() => { writeClipboard(text).then(() => setCopied(true), () => setCopied(false)); }}>
      <Icon name={copied ? 'check' : 'copy'} />
      <span aria-live="polite">{copied ? t.common.copied : t.common.copy}</span>
    </button>
  );
}

/** A shell command shown as code with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="command-line">
      <code>{command}</code>
      <CopyButton text={command} label={command} />
    </div>
  );
}
