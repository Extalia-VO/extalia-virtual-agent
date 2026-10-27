import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef, useState } from 'react';
import type { FurnishedOfficeView } from '../FurnishedFloors';
import type { Point3 } from '../layout';
import type { MovementDirector } from './director';

/** Route geometry refreshes about five times a second; the walk itself moves every frame. */
const REFRESH_SECONDS = 0.2;
/** Lift above the floor slab so the line never z-fights with rugs and tiles. */
const LIFT = 0.05;
/** The selection ring's lime, so the route reads as belonging to the selected character. */
const COLOR = '#d3eb7d';

/**
 * Thin dashed guide along the selected character's remaining route on its
 * floor. It shows only while that character walks and is in the current view.
 */
export function DestinationGuideLine({ director, selectedId, view }: {
  director: MovementDirector; selectedId: string | null; view: FurnishedOfficeView;
}) {
  const [points, setPoints] = useState<Point3[] | null>(null);
  const elapsed = useRef(REFRESH_SECONDS);
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current < REFRESH_SECONDS) return;
    elapsed.current = 0;
    const floor = selectedId ? director.floor(selectedId) : undefined;
    const inView = view === 'stack' || (typeof view === 'number' && floor === view);
    const route = selectedId && inView ? director.remainingRoute(selectedId) : [];
    setPoints(route.length >= 2 ? route.map((point): Point3 => [point[0], point[1] + LIFT, point[2]]) : null);
  });
  if (!points) return null;
  return <Line points={points} color={COLOR} lineWidth={1.5} dashed dashSize={0.3} gapSize={0.2}
    transparent opacity={0.9} depthWrite={false} />;
}
