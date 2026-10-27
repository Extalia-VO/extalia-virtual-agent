import type { SessionContextUsage } from '@extalia/platform';
import type { Messages } from '../../i18n';
import { contextLabel } from './contextLabel';

/**
 * The lead's context in use (v0.0.48): a share bar and the figure, toned at 80% and 95%.
 * `label` prefixes the word "Context" when the surrounding layout does not name it.
 */
export function ContextUsageLine({ t, context, label = false }: { t: Messages; context: SessionContextUsage; label?: boolean }) {
  const shown = contextLabel(context, t);
  return <span className={`context-usage tone-${shown.tone}`} data-tone={shown.tone} title={shown.title || undefined}>
    {label && <span className="context-usage-label">{t.context.label}</span>}
    {shown.percent !== undefined && <span className="context-usage-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, shown.percent)}%` }} /></span>}
    <span className="context-usage-text">{shown.value}</span>
  </span>;
}
