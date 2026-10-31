import type { ReactNode } from 'react';
import type { Group } from 'three';
import { useGLTF } from '@react-three/drei';
import { SourceAvatarBoundary } from './SourceAvatarBoundary';
import type { SourceAvatarPartUrls } from './sourceAssets';
import type { WardrobePartSlot } from './sourceWardrobeGeometry';

export type SourcePieceScenes = Partial<Record<WardrobePartSlot, Group>>;
const SLOTS = ['top', 'bottom', 'outer'] as const;

function Piece({ url, next }: { url: string; next(scene: Group): ReactNode }) {
  const asset = useGLTF(url, false, false);
  return next(asset.scene);
}

/** All selected pieces settle before the body appears; a failed slot keeps its scanned layer. */
export function SourcePieceAssets({ urls, children }: { urls: SourceAvatarPartUrls | undefined; children(scenes: SourcePieceScenes): ReactNode }) {
  const load = (index: number, scenes: SourcePieceScenes): ReactNode => {
    const slot = SLOTS[index];
    if (!slot) return children(scenes);
    const url = urls?.[slot];
    if (!url) return load(index + 1, scenes);
    return <SourceAvatarBoundary key={`${slot}|${url}`} fallback={load(index + 1, scenes)}>
      <Piece url={url} next={scene => load(index + 1, { ...scenes, [slot]: scene })} />
    </SourceAvatarBoundary>;
  };
  return load(0, {});
}
