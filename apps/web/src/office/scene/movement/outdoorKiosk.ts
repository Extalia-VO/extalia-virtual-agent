/** A scene-local automated café pickup; it never represents agent work. */
export const KIOSK_PREPARE_MS = 4500;
export const KIOSK_PICKUP_MS = 1500;

export interface OutdoorKioskVisit {
  readonly actorId: string;
  status: 'walking' | 'preparing' | 'pickup' | 'collected';
  since: number;
}

/** Single physical pickup point. Preparation starts only after its guest arrives. */
export class OutdoorKioskState {
  private current: OutdoorKioskVisit | null = null;
  snapshot(): Readonly<OutdoorKioskVisit> | null { return this.current; }
  request(actorId: string, now: number): boolean {
    if (this.current) return this.current.actorId === actorId;
    this.current = { actorId, status: 'walking', since: now };
    return true;
  }
  arrive(actorId: string, now: number): void {
    if (this.current?.actorId !== actorId || this.current.status !== 'walking') return;
    this.current.status = 'preparing'; this.current.since = now;
  }
  advance(now: number): void {
    const visit = this.current;
    if (!visit) return;
    if (visit.status === 'preparing' && now - visit.since >= KIOSK_PREPARE_MS) {
      visit.status = 'pickup'; visit.since = now;
    } else if (visit.status === 'pickup' && now - visit.since >= KIOSK_PICKUP_MS) {
      visit.status = 'collected'; visit.since = now;
    }
  }
  release(actorId: string): void { if (this.current?.actorId === actorId) this.current = null; }
  clear(): void { this.current = null; }
}

export const outdoorKioskState = new OutdoorKioskState();
