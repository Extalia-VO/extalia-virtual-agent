import type { CharacterAppearance } from '@extalia/core';
import { lazy, Suspense, useMemo } from 'react';
import type { LookIdentity } from '../scene/avatars/appearance';
import type { PortraitActivity } from './portrait3d/model';
import { PORTRAIT_HAIR_PATHS, portraitModel, type PortraitModel } from './portrait';

const Portrait3D = lazy(() => import('./portrait3d').then(module => ({ default: module.Portrait3D })));

/** Shoulder, neck and face outlines by presentation preset (feminine and masculine). */
const BODY = {
  feminine: {
    shoulders: 'M 6.5 50 L 7 43 C 7.8 37.2 13.2 34.2 18.2 33.5 L 25.8 33.5 C 30.8 34.2 36.2 37.2 37 43 L 37.5 50 Z',
    neck: [18.8, 6.4] as const,
    face: 'M 14.5 16.5 C 14.5 10.2 29.5 10.2 29.5 16.5 C 29.5 22.2 27.2 28.4 22 29.2 C 16.8 28.4 14.5 22.2 14.5 16.5 Z',
  },
  masculine: {
    shoulders: 'M 4.5 50 L 5.2 42.5 C 6 36.5 12 33.8 17.5 33 L 26.5 33 C 32 33.8 38 36.5 38.8 42.5 L 39.5 50 Z',
    neck: [18.2, 7.6] as const,
    face: 'M 14 16.5 C 14 10 30 10 30 16.5 C 30 22.5 28 28.6 22 29.5 C 16 28.6 14 22.5 14 16.5 Z',
  },
} as const;

function Portrait({ model }: { model: PortraitModel }) {
  const body = BODY[model.presentation];
  const hair = PORTRAIT_HAIR_PATHS[model.hairShape];
  const rimless = model.glasses === 'rimless';
  const frame = rimless ? '#70818b' : '#202428';
  const frameWidth = rimless ? 0.4 : 0.85;
  return <svg className="office-portrait-svg" viewBox="0 0 44 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    {model.backHair && <path d="M 12.2 16 C 10.5 22.5 10.2 30.5 11.8 36.5 L 16.5 35 C 15.8 29 15.5 22 15.8 16 Z M 31.8 16 C 33.5 22.5 33.8 30.5 32.2 36.5 L 27.5 35 C 28.2 29 28.5 22 28.2 16 Z" fill={model.hair} />}
    <path d={body.shoulders} fill={model.garment} />
    {/* Neck and subtle jaw shadow, then neckline and jacket lapels over it. */}
    <rect x={body.neck[0]} y="27.2" width={body.neck[1]} height="7.8" rx="2.6" fill={model.skin} />
    <path d="M 18.4 28.4 Q 22 30.8 25.6 28.4 L 25.6 30.2 Q 22 32 18.4 30.2 Z" fill="#000" opacity=".13" />
    {model.neckline === 'collar' && <path d="M 17.4 33.2 L 22 42.5 L 26.6 33.2 Z" fill={model.top} />}
    {model.neckline === 'scoop' && <>
      <path d="M 17.2 33.4 Q 22 41.5 26.8 33.4 Z" fill={model.top} />
      <path d="M 18.2 33.4 Q 22 38.6 25.8 33.4 Z" fill={model.skin} />
    </>}
    {model.neckline === 'crew' && <>
      <path d="M 17.5 33.2 Q 22 39.5 26.5 33.2 Z" fill={model.top} />
      <path d="M 18.2 33.4 Q 22 36.8 25.8 33.4" fill="none" stroke="#000" strokeOpacity=".2" strokeWidth="1" />
    </>}
    {model.neckline === 'turtleneck' && <rect x="18" y="30.2" width="8" height="4.8" rx="1.8" fill={model.top} />}
    {model.hasLayer && <path d="M 17.2 33.2 L 22 43.2 L 26.8 33.2" fill="none" stroke="#000" strokeOpacity=".16" strokeWidth="1.1" strokeLinejoin="round" />}
    {model.tie && model.neckline === 'collar' && <path d="M 21.1 34.8 L 22.9 34.8 L 23.4 45.5 L 22 47.8 L 20.6 45.5 Z" fill={model.accent} />}
    {/* Cranium base cap so hair and scalp always meet seamlessly without gaps. */}
    <path d="M 13.5 18 C 13.5 9.2 30.5 9.2 30.5 18 Z" fill={model.hair} />
    {/* Head: proportional ears, face, features. */}
    <ellipse cx="13.8" cy="21.2" rx="1.35" ry="2.2" fill={model.skin} />
    <ellipse cx="30.2" cy="21.2" rx="1.35" ry="2.2" fill={model.skin} />
    {model.earrings !== 'none' && <g fill="none" stroke="#f0d588" strokeWidth="0.8">
      {model.earrings === 'hoops'
        ? <><circle cx="13.5" cy="23.6" r="1.15" /><circle cx="30.5" cy="23.6" r="1.15" /></>
        : <><circle cx="13.6" cy="23.2" r="0.55" fill="#f0d588" /><circle cx="30.4" cy="23.2" r="0.55" fill="#f0d588" /></>}
    </g>}
    <path d={body.face} fill={model.skin} />
    <path d="M 15 23.8 Q 22 31.6 29 23.8" fill="#000" opacity=".05" />
    {/* Eyebrows, eyes with catchlight, nose, and warm smile. */}
    <path d="M 16.6 18.2 Q 18.5 17.3 20.4 18 M 23.6 18 Q 25.5 17.3 27.4 18.2" fill="none" stroke={model.hair} strokeWidth="0.95" strokeLinecap="round" />
    <ellipse cx="18.5" cy="20.8" rx="1.55" ry="1.2" fill="#f8fafb" />
    <circle cx="18.5" cy="20.8" r="0.95" fill="#2b2522" />
    <circle cx="18.15" cy="20.45" r="0.32" fill="#ffffff" />
    <ellipse cx="25.5" cy="20.8" rx="1.55" ry="1.2" fill="#f8fafb" />
    <circle cx="25.5" cy="20.8" r="0.95" fill="#2b2522" />
    <circle cx="25.15" cy="20.45" r="0.32" fill="#ffffff" />
    <path d="M 21.7 20.8 L 22 23.4 L 22.8 23.4" fill="none" stroke="#000" strokeOpacity=".22" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M 20.3 25.8 Q 22 26.9 23.7 25.8" fill="none" stroke="#7a3b32" strokeOpacity=".58" strokeWidth="0.95" strokeLinecap="round" />
    <path d={hair} fill={model.hair} />
    <path d="M 16.5 8.5 Q 22 6.8 27.5 8.5" fill="none" stroke="#ffffff" strokeOpacity=".1" strokeWidth="1.1" strokeLinecap="round" />
    {model.glasses !== 'none' && <g stroke={frame} strokeWidth={frameWidth} fill="rgba(255,255,255,.16)">
      {model.glasses === 'round'
        ? <><circle cx="18.5" cy="20.8" r="2.5" /><circle cx="25.5" cy="20.8" r="2.5" /></>
        : <><rect x="16" y="19.2" width="5" height="3.2" rx={rimless ? 0.3 : 0.9} /><rect x="23" y="19.2" width="5" height="3.2" rx={rimless ? 0.3 : 0.9} /></>}
      <path d="M 21 20.7 L 23 20.7 M 14 20.5 L 16 20.5 M 28 20.5 L 30 20.5" fill="none" />
    </g>}
    {model.headphones && <g>
      <path d="M 11.8 20 C 11.8 9.8 32.2 9.8 32.2 20" fill="none" stroke="#2c343b" strokeWidth="2" strokeLinecap="round" />
      <rect x="10.8" y="18.8" width="2.8" height="6" rx="1.4" fill="#44515a" /><rect x="30.4" y="18.8" width="2.8" height="6" rx="1.4" fill="#44515a" />
    </g>}
    {model.badge && <g>
      <path d="M 28.8 38.5 L 28.8 41.2" stroke={model.accent} strokeWidth="0.8" />
      <rect x="26.8" y="41.2" width="4" height="5" rx="0.6" fill="#f4f2e9" stroke="#87969b" strokeWidth="0.4" />
      <circle cx="28.8" cy="42.8" r="0.65" fill={model.accent} />
    </g>}
  </svg>;
}

/**
 * An animated crop of the same body/model as the Office, with a lightweight
 * illustration while loading or when graphics are unavailable. Decorative:
 * the character's name is always shown next to it.
 */
export function AgentPortrait({ characterId, appearance, identity, activity }: {
  characterId: string; appearance?: CharacterAppearance | undefined;
  /** v0.0.30: the name (and explicit gender) the generated look is seeded from. */
  identity?: LookIdentity | undefined;
  activity?: PortraitActivity | undefined;
}) {
  const seed = identity?.seed, presentation = identity?.presentation;
  const model = useMemo(() => portraitModel(characterId, appearance, seed ? { seed, ...(presentation ? { presentation } : {}) } : undefined), [characterId, appearance, seed, presentation]);
  const fallback = <Portrait model={model} />;
  return <span className="office-portrait" aria-hidden="true" data-portrait-character={characterId}>
    <Suspense fallback={fallback}><Portrait3D characterId={characterId} appearance={appearance} identity={identity} activity={activity} fallback={fallback} /></Suspense>
  </span>;
}
