const revealDuration = 740, hoverDuration = 190, burstDuration = 780;
const ease = (value: number) => value * value * (3 - 2 * value);

export interface ShelfFlightPoint { x: number; y: number; z: number }
export interface ShelfFlight { start: ShelfFlightPoint; controlA: ShelfFlightPoint; controlB: ShelfFlightPoint; home: ShelfFlightPoint; direction: number }

/** Camera-projected cubic path. Extents include the entire rotated book, not only its centre. */
export function createShelfFlight(index: number, home: ShelfFlightPoint, extent: { x: number; y: number }, from?: ShelfFlightPoint): ShelfFlight {
  const side = index % 3, unit = ((index * 37) % 17) / 16, direction = side === 1 ? -1 : 1;
  const start = from ? { x: from.x, y: from.y, z: from.z } : side === 2
    ? { x: -.85 + unit * 1.7, y: -1 - extent.y - .16, z: home.z }
    : { x: (side === 0 ? -1 : 1) * (1 + extent.x + .16), y: -.65 + unit * 1.3, z: home.z };
  const controlA = { x: start.x + (home.x - start.x) * .36 + direction * .12, y: start.y + (home.y - start.y) * .38 + .4, z: start.z + (home.z - start.z) / 3 };
  const controlB = { x: home.x - direction * .16, y: home.y + .3, z: start.z + (home.z - start.z) * 2 / 3 };
  return { start, controlA, controlB, home: { ...home }, direction };
}

export function shelfFlightPose(path: ShelfFlight, progress: number, postureProgress = progress): ShelfFlightPoint & { roll: number; tilt: number; scale: number } {
  const t = Math.max(0, Math.min(1, progress)), rest = 1 - Math.max(0, Math.min(1, postureProgress));
  const remaining = 1 - t;
  if (t === 1) return { ...path.home, roll: 0, tilt: 0, scale: 1 };
  const cubic = (key: keyof ShelfFlightPoint) => remaining ** 3 * path.start[key] + 3 * remaining ** 2 * t * path.controlA[key] + 3 * remaining * t ** 2 * path.controlB[key] + t ** 3 * path.home[key];
  const point = t === 0 ? path.start : t === 1 ? path.home : { x: cubic('x'), y: cubic('y'), z: cubic('z') };
  return { ...point, roll: path.direction * rest * -.32, tilt: rest * .24, scale: 1 - rest * .24 };
}

/** Finite arrival, hover easing and bursts; the renderer separately animates active hover smoke. */
export class SkillShelfMagic {
  private elapsed = 0;
  private hoverElapsed = hoverDuration;
  private hoverIndex: number | null = null;
  private hoverStarts: number[];
  private hoverValues: number[];
  private burstElapsed = burstDuration;
  burstIndex: number | null = null;

  constructor(private count: number) {
    this.hoverStarts = Array(count).fill(0); this.hoverValues = Array(count).fill(0);
    if (!count) this.elapsed = revealDuration;
  }

  private delay(index: number) { return Math.min(index, 17) * 76; }
  get animating(): boolean {
    return this.elapsed < revealDuration + this.delay(Math.max(0, this.count - 1)) || this.hoverElapsed < hoverDuration || this.burstElapsed < burstDuration;
  }
  get burst(): number { return this.burstIndex === null ? 1 : this.burstElapsed / burstDuration; }
  reveal(index: number, millisecondsAgo = 0): number {
    return ease(Math.max(0, Math.min(1, (this.elapsed - Math.max(0, millisecondsAgo) - this.delay(index)) / revealDuration)));
  }
  hover(index: number): number { return this.hoverValues[index] ?? 0; }

  setHover(index: number | null): void {
    if (index === this.hoverIndex) return;
    this.hoverStarts = [...this.hoverValues]; this.hoverElapsed = 0; this.hoverIndex = index;
    this.burstIndex = index; this.burstElapsed = index === null ? burstDuration : 0;
  }

  advance(milliseconds: number, reduced = false): void {
    const delta = Math.max(0, milliseconds);
    this.elapsed = Math.min(revealDuration + this.delay(Math.max(0, this.count - 1)), this.elapsed + delta);
    this.hoverElapsed = Math.min(hoverDuration, this.hoverElapsed + delta);
    this.burstElapsed = Math.min(burstDuration, this.burstElapsed + delta);
    if (reduced) {
      this.elapsed = revealDuration + this.delay(Math.max(0, this.count - 1));
      this.hoverElapsed = hoverDuration; this.burstElapsed = burstDuration;
      this.hoverValues.fill(0); this.hoverStarts.fill(0);
      return;
    }
    const progress = ease(this.hoverElapsed / hoverDuration);
    this.hoverValues = this.hoverStarts.map((start, index) => start + ((index === this.hoverIndex ? 1 : 0) - start) * progress);
  }
}
