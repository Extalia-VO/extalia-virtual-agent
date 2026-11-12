import type { Point3 } from '../layout';
import { BEAT_S, CHAIR_FRONT_APPROACH, GRIP_STAND, chairWalkPath, chairWorld, scootPull, sittingCentre, smooth01, standPull, type ChairSide } from './chairChoreography';
import type { SeatApproach } from './navGraph';

export type ChairManeuverClear = (seat: SeatApproach, from: Readonly<Point3>, to: Readonly<Point3>, radius?: number) => boolean;
const CURVE_SAMPLES = 64;

/**
 * Select a statically clear complete chair maneuver before taking hand contact.
 * The caller retains the choice through all beats and still checks physical
 * bodies/current clearance each frame. This never changes the seat or actor.
 */
export function chooseChairManeuverSide(seat: SeatApproach, kind: 'sit' | 'stand', from: Readonly<Point3>, preferred: ChairSide,
  clear: ChairManeuverClear): ChairSide | null {
  if (![...from, ...seat.seat, seat.rotationY].every(Number.isFinite)) return null;
  const safe = (side: ChairSide): boolean => {
    let previous: Readonly<Point3> = from;
    const visit = (point: Readonly<Point3>): boolean => {
      if (!clear(seat, previous, point, .29)) return false;
      previous = point;
      return true;
    };
    const walk = (beat: string): boolean => chairWalkPath(seat, beat, side).every(visit);
    const curve = (pointAt: (fraction: number) => Point3): boolean => {
      // Segment predicates sweep the capsule between samples, not just vertices.
      for (let sample = 0; sample <= CURVE_SAMPLES; sample++) if (!visit(pointAt(sample / CURVE_SAMPLES))) return false;
      return true;
    };
    if (kind === 'stand') {
      if (!curve(fraction => chairWorld(seat, standPull(fraction), 0, 0,
        CHAIR_FRONT_APPROACH * smooth01((fraction - .6) / .4), [0, 0, 0], side))) return false;
      if (!walk('walk-out')) return false;
      return curve(fraction => chairWorld(seat, 1 - smooth01(fraction), GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], side));
    }
    if (!walk('grip-walk')
      || !curve(fraction => chairWorld(seat, smooth01(fraction), GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], side))
      || !walk('walk-sit')
      || !curve(fraction => chairWorld(seat, 1, 0, 0, CHAIR_FRONT_APPROACH * (1 - smooth01(fraction)), [0, 0, 0], side))
      || !curve(fraction => sittingCentre(seat, scootPull(fraction * BEAT_S.scoot), [0, 0, 0], side))) return false;
    return visit(seat.seat);
  };
  if (safe(preferred)) return preferred;
  const opposite = -preferred as ChairSide;
  return safe(opposite) ? opposite : null;
}
