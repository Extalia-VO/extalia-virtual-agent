import type { Messages } from '../../i18n';
import type { OfficeKpis } from './kpis';

const ORDER = ['running', 'waiting', 'working', 'errors', 'observed', 'idle'] as const;

/** Six counters derived from presences and events; each explains its meaning on hover. */
export function OfficeMetrics({ t, kpis }: { t: Messages; kpis: OfficeKpis }) {
  const k = t.officeOverlay.kpi;
  return <dl className="office-metrics">
    {ORDER.map(key => <div key={key} className={`office-metric ${key === 'errors' && kpis.errors > 0 ? 'attention' : ''}`} title={k.hints[key]}>
      <dt>{k[key]}</dt><dd>{kpis[key]}</dd>
    </div>)}
  </dl>;
}
