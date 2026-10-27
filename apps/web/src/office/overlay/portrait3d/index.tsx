import { useEffect, useRef, useState, type ReactNode } from 'react';
import { attachPortrait } from './renderer';
import { portraitSubject, type PortraitSubject } from './model';

export type { PortraitActivity, PortraitSubject } from './model';
export { getPortrait3DDiagnostics, getPortrait3DScenes } from './renderer';

export interface Portrait3DProps extends PortraitSubject {
  fallback: ReactNode;
  className?: string;
}

/** Every visible portrait shares one renderer; this canvas owns only a 2D copy. */
export function Portrait3D({ fallback, className, ...subject }: Portrait3DProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<ReturnType<typeof attachPortrait> | null>(null);
  const latest = useRef(subject);
  useEffect(() => { latest.current = subject; }, [subject]);
  const key = portraitSubject(subject).key;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const target = canvas.current;
    const attached = attachPortrait(target, latest.current, ready => setReadyKey(ready ? key : null));
    handle.current = attached;
    const visibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      attached.setVisible(entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0));
    });
    visibility?.observe(target);
    return () => { visibility?.disconnect(); attached.remove(); handle.current = null; };
  }, [key]);
  useEffect(() => { handle.current?.update(subject); }, [subject]);
  const ready = readyKey === key;
  return <span className={className ?? 'office-portrait-3d'} aria-hidden="true" style={{ display: 'block', position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    {!ready && fallback}
    <canvas ref={canvas} width={192} height={224} data-portrait-3d={ready ? 'ready' : 'loading'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: ready ? 1 : 0, pointerEvents: 'none' }} />
  </span>;
}
