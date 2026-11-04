import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { Brand } from '../ui/Brand';
import { loadIndex } from './loadCatalog';
import { readLoad } from './loadFeed';
import { CREEP_AFTER, STAGE_FLOOR, creepTarget, describeItem, easeStep, loadTarget, type OfficeLoadStage } from './loadProgress';

export type { OfficeLoadStage } from './loadProgress';

/** What is loading right now, from the real loader state; falls back to the stage text. */
export function loadingLabel(t: Messages, stage: OfficeLoadStage): string {
  if (stage === 'engine') return t.officeUx.loadingEngine;
  if (stage === 'ready') return t.officeUx.loadingReady;
  const { item, loaded, total } = readLoad();
  const entry = describeItem(item, loadIndex);
  if (!entry || total <= 0) return t.officeUx.loadingScene;
  return t.officeUx.loadingItem(t.officeUx.loadingCategories[entry.category], entry.name, Math.min(total, loaded + 1), total);
}

/** Covers the canvas until the first frame is drawn, then fades out. The bar and count are written through refs, never per-frame renders. */
export function OfficeLoading({ t, stage, reducedMotion }: { t: Messages; stage: OfficeLoadStage; reducedMotion: boolean }) {
  const [finished, setFinished] = useState(false);
  const [gone, setGone] = useState(false);
  const [initial] = useState(() => STAGE_FLOOR[stage]);
  const [aria, setAria] = useState({ percent: Math.floor(initial), label: loadingLabel(t, stage) });
  const [visibleLabel, setVisibleLabel] = useState(aria.label);
  const bar = useRef<HTMLSpanElement>(null);
  const percentText = useRef<HTMLSpanElement>(null);
  const live = useRef({ stage, t, reducedMotion });
  useEffect(() => { live.current = { stage, t, reducedMotion }; });

  useEffect(() => {
    if (gone) return;
    let frame = 0, last = performance.now(), idle = 0, seen = '', target = initial, displayed = initial;
    let labelAt = 0, ariaAt = 0, srAt = 0, shownPercent = Math.floor(initial), shownLabel = '', srLabel = '';
    const tick = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      const { stage: current, t: messages, reducedMotion: still } = live.current;
      const snap = readLoad();
      const key = `${snap.loaded}/${snap.total}`;
      if (key !== seen) { seen = key; idle = 0; } else idle += dt;
      target = loadTarget(current, snap.loaded, snap.total, target);
      if (current !== 'ready' && idle > CREEP_AFTER) target = creepTarget(current, target, dt);
      displayed = still ? target : current === 'ready' ? easeStep(displayed, target, dt, { tau: 0.12, minSpeed: 60, maxSpeed: 160 }) : easeStep(displayed, target, dt);
      if (bar.current) bar.current.style.width = `${displayed}%`;
      const whole = Math.min(100, Math.floor(displayed + 1e-6));
      if (whole !== shownPercent) {
        shownPercent = whole;
        if (percentText.current) percentText.current.textContent = `${whole}%`;
      }
      if (now - labelAt > 200) {
        labelAt = now;
        const label = loadingLabel(messages, current);
        if (label !== shownLabel) { shownLabel = label; setVisibleLabel(label); }
        // Screen readers get a calmer cadence than the eye: a few updates per second at most, label at most every 0.8 s.
        if (now - ariaAt > 500) { ariaAt = now; setAria(prev => prev.percent === shownPercent ? prev : { ...prev, percent: shownPercent }); }
        if (now - srAt > 800 && label !== srLabel) { srAt = now; srLabel = label; setAria(prev => ({ ...prev, label })); }
      }
      if (current === 'ready' && displayed >= 99.9) {
        if (percentText.current) percentText.current.textContent = '100%';
        setAria({ percent: 100, label: messages.officeUx.loadingReady });
        setVisibleLabel(messages.officeUx.loadingReady);
        setFinished(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [gone, initial]);

  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => setGone(true), reducedMotion ? 0 : 450);
    return () => clearTimeout(timer);
  }, [finished, reducedMotion]);

  if (gone) return null;
  return <div className={`office-loading ${finished ? 'done' : ''}`}>
    <div className="office-loading-card">
      <Brand />
      <div className="office-loading-bar" role="progressbar" aria-label={t.officeUx.loadingLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={aria.percent}>
        <span ref={bar} className={reducedMotion ? 'office-loading-fill' : 'office-loading-fill shimmer'} style={{ width: `${initial}%` }} />
      </div>
      <p><span className="office-loading-label" aria-hidden="true">{visibleLabel}</span><span ref={percentText} className="office-loading-percent" aria-hidden="true">{`${Math.floor(initial)}%`}</span></p>
      <span className="visually-hidden" role="status" aria-live="polite">{aria.label}</span>
    </div>
  </div>;
}
