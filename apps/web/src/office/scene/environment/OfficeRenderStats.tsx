import { useSyncExternalStore } from 'react';
import { MESSAGES, type Language } from '../../../i18n';
import { getOfficeFps, subscribeOfficeFps } from './renderStats';
import './officeRenderStats.css';

/** Native-resolution, passive readout; only this small overlay subscribes to FPS changes. */
export function OfficeRenderStats({ language }: { language: Language }) {
  const fps = useSyncExternalStore(subscribeOfficeFps, getOfficeFps, getOfficeFps);
  const text = MESSAGES[language].office;
  const label = fps === null ? text.renderFpsWaiting : text.renderFpsLabel(fps);
  return <span className="office-render-stats" role="status" aria-live="off" aria-label={label} title={label}>
    <span aria-hidden="true">{text.renderFps} {fps ?? '—'}</span>
  </span>;
}
