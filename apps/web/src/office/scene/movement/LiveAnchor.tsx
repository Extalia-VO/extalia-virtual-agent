import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { Point3 } from '../layout';
import type { CharacterPositionSource } from './positionStore';

/** A group that stays on a character's live position (or `fallback` without one); children use offsets. */
export function LiveAnchor({ source, id, fallback, children }: {
  source?: CharacterPositionSource | undefined; id: string; fallback: Readonly<Point3>; children: ReactNode;
}) {
  const group = useRef<Group>(null);
  useFrame(() => {
    const point = source?.position(id);
    if (point && group.current) group.current.position.set(point[0], point[1], point[2]);
  });
  const start = source?.position(id) ?? fallback;
  return <group ref={group} position={[start[0], start[1], start[2]]}>{children}</group>;
}
