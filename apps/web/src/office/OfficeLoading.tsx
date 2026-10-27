import { useEffect, useState } from 'react';
import type { Messages } from '../i18n';
import { Brand } from '../ui/Brand';

/** Real loading stages: the 3D code chunk, then the renderer building the scene, then the first drawn frame. */
export type OfficeLoadStage = 'engine' | 'scene' | 'ready';

/** Progress never claims more than the stage reached: it eases toward the stage's ceiling and jumps to 100 % when ready. */
const CEILING: Record<OfficeLoadStage, number> = { engine: 0.45, scene: 0.94, ready: 1 };
const FLOOR: Record<OfficeLoadStage, number> = { engine: 0.04, scene: 0.5, ready: 1 };

export function nextLoadProgress(current: number, stage: OfficeLoadStage): number {
  const from = Math.max(current, FLOOR[stage]);
  if (stage === 'ready') return 1;
  return Math.min(CEILING[stage], from + (CEILING[stage] - from) * 0.08);
}

/** Covers the canvas until the first frame is drawn, then fades out. */
export function OfficeLoading({ t, stage, reducedMotion }: { t: Messages; stage: OfficeLoadStage; reducedMotion: boolean }) {
  const [progress, setProgress] = useState(FLOOR.engine);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (stage === 'ready') {
      const timer = setTimeout(() => setGone(true), reducedMotion ? 0 : 450);
      return () => clearTimeout(timer);
    }
    const timer = setInterval(() => setProgress(value => nextLoadProgress(value, stage)), 120);
    return () => clearInterval(timer);
  }, [stage, reducedMotion]);
  if (gone && stage === 'ready') return null;
  const percent = Math.round((stage === 'ready' ? 1 : Math.max(FLOOR[stage], progress)) * 100);
  const label = stage === 'engine' ? t.officeUx.loadingEngine : stage === 'scene' ? t.officeUx.loadingScene : t.officeUx.loadingReady;
  return <div className={`office-loading ${stage === 'ready' ? 'done' : ''}`} role="status" aria-live="polite">
    <div className="office-loading-card">
      <Brand />
      <div className="office-loading-bar" role="progressbar" aria-label={t.officeUx.loadingLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p><span>{label}</span><span className="office-loading-percent">{percent}%</span></p>
    </div>
  </div>;
}
