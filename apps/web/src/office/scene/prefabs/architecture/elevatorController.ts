/** Independent on-demand cabs with reserved standing places and one doorway token. */
import { FLOOR_HEIGHT, OFFICE_BUILDING } from "../../layout";

export type ElevatorFloor = 1 | 2 | 3;
export type ElevatorId = "A" | "B";
export type ElevatorPhase = "idle" | "dispatching" | "opening" | "boarding" | "closing" | "riding" | "alighting";
export const ELEVATOR_FLOOR_HEIGHT = FLOOR_HEIGHT;
export const ELEVATOR_CAPACITY = 3;
/** Back places fill first. The center aisle stays clear for the doorway. */
export const ELEVATOR_STANDING_SLOTS = [[0.675, -0.9], [0.675, 0.9], [-0.475, 0.9]] as const;
const geometry = {
  x: OFFICE_BUILDING.east + 1.925, doorX: OFFICE_BUILDING.east + 0.15, approachX: OFFICE_BUILDING.east - 1.1, doorWidth: 1.4,
  shaftWidth: 3, shaftDepth: 3, cabWidth: 2.6, cabDepth: 2.6, cabHeight: 2.45,
  travelSecondsPerFloor: 3.2, doorSeconds: 0.85
} as const;
// Center the complete pair on the building depth, retaining a 40 cm shaft gap.
const elevatorCenterZ = (OFFICE_BUILDING.north + OFFICE_BUILDING.south) / 2;
const elevatorHalfSpacing = (geometry.shaftDepth + 0.4) / 2;
export const GLASS_ELEVATORS = [
  { ...geometry, id: "A", z: elevatorCenterZ - elevatorHalfSpacing },
  { ...geometry, id: "B", z: elevatorCenterZ + elevatorHalfSpacing }
] as const;
export const GLASS_ELEVATOR = GLASS_ELEVATORS[0];
export function getElevatorGeometry(id: ElevatorId = "A") { return GLASS_ELEVATORS[id === "A" ? 0 : 1]; }

export interface ElevatorRide { riderId: string; from: ElevatorFloor; to: ElevatorFloor; elevatorId?: ElevatorId; }
export interface ElevatorPassenger extends ElevatorRide { slot: number; boarded: boolean; }
export interface ElevatorSnapshot {
  elevatorId: ElevatorId;
  phase: ElevatorPhase;
  y: number;
  doors: number;
  openFloor: ElevatorFloor | null;
  /** Compatibility view of the first reservation; use passengers for rider-specific state. */
  rider: ElevatorRide | null;
  boarded: boolean;
  passengers: readonly ElevatorPassenger[];
  queue: readonly ElevatorRide[];
  direction: -1 | 0 | 1;
  doorwayRiderId: string | null;
}
export function floorElevation(floor: ElevatorFloor): number { return (floor - 1) * ELEVATOR_FLOOR_HEIGHT; }
function rideDirection(ride: ElevatorRide): -1 | 1 { return ride.to > ride.from ? 1 : -1; }
function validRide(ride: ElevatorRide) { return !!ride.riderId && [1, 2, 3].includes(ride.from) && [1, 2, 3].includes(ride.to) && ride.from !== ride.to; }

class ElevatorController {
  private listeners = new Set<() => void>();
  private phase: ElevatorPhase = "idle";
  private y = 0;
  private doors = 0;
  private passengers: ElevatorPassenger[] = [];
  private queue: ElevatorRide[] = [];
  private waitingSlots = new Map<string, { floor: ElevatorFloor; slot: number }>();
  private lastRider: ElevatorRide | null = null;
  private direction: -1 | 0 | 1 = 0;
  private elapsed = 0;
  private motionStart = 0;
  private motionTarget: ElevatorFloor = 1;
  private motionDuration = 0;
  constructor(readonly id: ElevatorId) {}
  private emit() { this.listeners.forEach(listener => listener()); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private atFloor(): ElevatorFloor | null {
    const floor = Math.round(this.y / ELEVATOR_FLOOR_HEIGHT) + 1;
    return floor >= 1 && floor <= 3 && Math.abs(this.y - floorElevation(floor as ElevatorFloor)) < 1e-6 ? floor as ElevatorFloor : null;
  }
  private exiting() { return this.passengers.filter(p => p.boarded && p.to === this.atFloor()).sort((a, b) => b.slot - a.slot); }
  private entering() { return this.passengers.filter(p => !p.boarded && p.from === this.atFloor()).sort((a, b) => a.slot - b.slot); }
  private doorwayRider() {
    if (this.doors !== 1) return null;
    if (this.phase === "alighting") return this.exiting()[0]?.riderId ?? null;
    if (this.phase === "boarding") return this.entering()[0]?.riderId ?? null;
    return null;
  }
  snapshot(): ElevatorSnapshot {
    const rider = this.currentRide();
    return {
      elevatorId: this.id, phase: this.phase, y: this.y, doors: this.doors,
      openFloor: this.doors > 0 ? this.atFloor() : null, rider,
      boarded: rider ? this.passengers.some(p => p.riderId === rider.riderId && p.boarded) : false,
      passengers: this.passengers.map(p => ({ ...p })), queue: this.queue.map(r => ({ ...r })),
      direction: this.direction, doorwayRiderId: this.doorwayRider()
    };
  }
  busy() { return this.phase !== "idle"; }
  currentRide(): ElevatorRide | null {
    const p = this.passengers[0] ?? this.lastRider;
    return p ? { riderId: p.riderId, from: p.from, to: p.to, elevatorId: this.id } : null;
  }
  queueLength() { return this.queue.length; }
  hasRider(id: string) { return this.passengers.some(p => p.riderId === id) || this.queue.some(p => p.riderId === id); }
  waitingSlot(riderId: string): number | null { return this.waitingSlots.get(riderId)?.slot ?? null; }
  standingPosition(riderId: string): [number, number, number] | null {
    const p = this.passengers.find(p => p.riderId === riderId);
    if (!p) return null;
    const g = getElevatorGeometry(this.id), offset = ELEVATOR_STANDING_SLOTS[p.slot]!;
    return [g.x + offset[0], this.y, g.z + offset[1]];
  }
  private compatible(ride: ElevatorRide) {
    if (rideDirection(ride) !== this.direction) return false;
    const fromY = floorElevation(ride.from);
    if (this.phase === "dispatching") return ride.from === this.motionTarget;
    if (this.phase === "opening" || this.phase === "boarding" || this.phase === "alighting") return ride.from === this.atFloor();
    if (this.phase === "riding" || this.phase === "closing") {
      const destinations = this.passengers.filter(p => p.boarded).map(p => floorElevation(p.to));
      if (!destinations.length) return false;
      const furthest = this.direction === 1 ? Math.max(...destinations) : Math.min(...destinations);
      return (fromY - this.y) * this.direction > 1e-6 && (furthest - fromY) * this.direction >= 0;
    }
    return false;
  }
  canAccept(ride: ElevatorRide) {
    if (!validRide(ride) || this.hasRider(ride.riderId)) return false;
    if (!this.busy()) return true;
    if (!this.compatible(ride)) return false;
    // Reserve capacity for already accepted compatible pickups as well as current riders.
    const leaving = this.passengers.filter(p => p.boarded && (floorElevation(ride.from) - floorElevation(p.to)) * this.direction >= 0).length;
    const committed = this.passengers.length - leaving + this.queue.filter(q => this.compatible(q)).length;
    return committed < ELEVATOR_CAPACITY;
  }
  private reserve(ride: ElevatorRide) {
    const used = new Set(this.passengers.map(p => p.slot));
    const slot = ELEVATOR_STANDING_SLOTS.findIndex((_, i) => !used.has(i));
    if (slot >= 0) this.passengers.push({ ...ride, elevatorId: this.id, slot, boarded: false });
  }
  private reserveAtFloor(floor: ElevatorFloor) {
    for (let i = 0; i < this.queue.length && this.passengers.length < ELEVATOR_CAPACITY;) {
      const ride = this.queue[i]!;
      if (ride.from === floor && rideDirection(ride) === this.direction) { this.queue.splice(i, 1); this.reserve(ride); }
      else i++;
    }
  }
  private beginOpening() { this.elapsed = 0; this.phase = "opening"; }
  private beginClosing() { this.elapsed = (1 - this.doors) * geometry.doorSeconds; this.phase = "closing"; }
  private beginMotion(target: ElevatorFloor, purpose: "dispatching" | "riding") {
    if (this.doors !== 0) return;
    this.motionStart = this.y; this.motionTarget = target;
    this.motionDuration = Math.abs(floorElevation(target) - this.y) / ELEVATOR_FLOOR_HEIGHT * geometry.travelSecondsPerFloor;
    this.elapsed = 0; this.phase = purpose;
    if (this.motionDuration < 1e-6) this.beginOpening();
  }
  private startNext() {
    this.lastRider = null;
    const next = this.queue.shift();
    this.phase = "idle"; this.direction = 0;
    if (next) {
      this.direction = rideDirection(next); this.reserve(next); this.reserveAtFloor(next.from);
      this.beginMotion(next.from, "dispatching");
    }
  }
  private serviceStop() {
    if (this.exiting().length) { this.phase = "alighting"; return; }
    const floor = this.atFloor();
    if (floor !== null) this.reserveAtFloor(floor);
    if (this.entering().length) this.phase = "boarding";
    else this.beginClosing();
  }
  private depart() {
    this.lastRider = null;
    if (!this.passengers.length) { this.startNext(); return; }
    const stops = this.passengers.filter(p => p.boarded).map(p => p.to);
    // Compatible pickups lie ahead within this batch's destination range.
    for (const q of this.queue) if (this.compatible(q) && this.passengers.length < ELEVATOR_CAPACITY) stops.push(q.from);
    const ahead = stops.filter(f => (floorElevation(f) - this.y) * this.direction > 1e-6);
    if (ahead.length) this.beginMotion((this.direction === 1 ? Math.min(...ahead) : Math.max(...ahead)) as ElevatorFloor, "riding");
    else this.startNext();
  }
  request(ride: ElevatorRide): "dispatched" | "queued" | "already" {
    if (!validRide(ride) || this.hasRider(ride.riderId)) return "already";
    const dispatch = !this.busy();
    const accept = this.canAccept(ride);
    this.reserveWaitingSlot(ride);
    this.queue.push({ ...ride, elevatorId: this.id });
    if (dispatch) this.startNext();
    else if (accept && (this.phase === "opening" || this.phase === "boarding") && this.atFloor() === ride.from) this.reserveAtFloor(ride.from);
    else if (accept && this.phase === "dispatching") this.reserveAtFloor(ride.from);
    else if (accept && this.phase === "riding" && (floorElevation(this.motionTarget) - floorElevation(ride.from)) * this.direction > 0) {
      // Replan from the actual cabin position; accepting a nearer pickup never teleports it.
      this.beginMotion(ride.from, "riding");
    }
    this.emit();
    return dispatch ? "dispatched" : "queued";
  }
  /**
   * Hold a landing waiting spot without calling the cab. Riders far away keep a
   * spot, but the car only reacts once `request` runs at the elevator front.
   */
  reserveWaitingSlot(ride: ElevatorRide): number | null {
    if (!validRide(ride) || this.hasRider(ride.riderId)) return this.waitingSlot(ride.riderId);
    const existing = this.waitingSlots.get(ride.riderId);
    if (existing && existing.floor === ride.from) return existing.slot;
    const usedWaiting = new Set([...this.waitingSlots.entries()]
      .filter(([id, p]) => id !== ride.riderId && p.floor === ride.from).map(([, p]) => p.slot));
    let waitingSlot = 0;
    while (usedWaiting.has(waitingSlot)) waitingSlot++;
    this.waitingSlots.set(ride.riderId, { floor: ride.from, slot: waitingSlot });
    this.emit();
    return waitingSlot;
  }
  canBoard(riderId: string) { return this.phase === "boarding" && this.doorwayRider() === riderId; }
  confirmBoarded(riderId: string) {
    if (!this.canBoard(riderId)) return false;
    this.passengers.find(p => p.riderId === riderId)!.boarded = true;
    this.waitingSlots.delete(riderId);
    if (!this.entering().length) this.beginClosing();
    this.emit(); return true;
  }
  canExit(riderId: string) { return this.phase === "alighting" && this.doorwayRider() === riderId; }
  confirmExited(riderId: string) {
    if (!this.canExit(riderId)) return false;
    const index = this.passengers.findIndex(p => p.riderId === riderId);
    this.lastRider = this.passengers.splice(index, 1)[0]!;
    this.serviceStop(); this.emit(); return true;
  }
  private remove(riderId: string, force: boolean) {
    const queued = this.queue.findIndex(p => p.riderId === riderId);
    if (queued >= 0) { this.queue.splice(queued, 1); this.waitingSlots.delete(riderId); this.emit(); return true; }
    const index = this.passengers.findIndex(p => p.riderId === riderId);
    if (index < 0 && this.waitingSlots.delete(riderId)) { this.emit(); return true; }
    if (index < 0 || this.passengers[index]!.boarded && !force) return false;
    this.passengers.splice(index, 1);
    this.waitingSlots.delete(riderId);
    if (this.phase === "boarding" || this.phase === "alighting") this.serviceStop();
    else if (this.phase === "opening" && !this.passengers.length) this.beginClosing();
    this.emit(); return true;
  }
  cancel(riderId: string) { return this.remove(riderId, false); }
  release(riderId: string) { this.remove(riderId, true); return this.currentRide(); }
  reset() {
    this.queue = []; this.passengers = []; this.lastRider = null; this.waitingSlots.clear();
    if (this.phase === "boarding" || this.phase === "alighting" || this.phase === "opening") this.beginClosing();
    this.emit();
  }
  tick(delta: number) {
    if (!Number.isFinite(delta) || delta <= 0 || !this.busy()) return;
    let remaining = delta;
    while (remaining > 1e-9) {
      if (this.phase === "idle" || this.phase === "boarding" || this.phase === "alighting") break;
      if (this.phase === "dispatching" || this.phase === "riding") {
        const used = Math.min(remaining, this.motionDuration - this.elapsed);
        this.elapsed += used; remaining -= used;
        const t = Math.min(1, this.elapsed / this.motionDuration);
        const eased = t * t * t * (t * (t * 6 - 15) + 10);
        this.y = this.motionStart + (floorElevation(this.motionTarget) - this.motionStart) * eased;
        if (this.elapsed < this.motionDuration - 1e-9) break;
        this.y = floorElevation(this.motionTarget);
        if (!this.passengers.length) this.startNext();
        else this.beginOpening();
      } else {
        const used = Math.min(remaining, geometry.doorSeconds - this.elapsed);
        this.elapsed += used; remaining -= used;
        const t = Math.min(1, this.elapsed / geometry.doorSeconds);
        this.doors = this.phase === "opening" ? t : 1 - t;
        if (this.elapsed < geometry.doorSeconds - 1e-9) break;
        if (this.phase === "opening") { this.doors = 1; this.serviceStop(); }
        else { this.doors = 0; this.depart(); }
      }
    }
    this.emit();
  }
}
const controllers: Record<ElevatorId, ElevatorController> = { A: new ElevatorController("A"), B: new ElevatorController("B") };
export function subscribeElevator(listener: () => void, id: ElevatorId = "A") { return controllers[id].subscribe(listener); }
export function elevatorSnapshot(id: ElevatorId = "A") { return controllers[id].snapshot(); }
export function isElevatorBusy(id: ElevatorId = "A") { return controllers[id].busy(); }
export function currentElevatorRide(id: ElevatorId = "A") { return controllers[id].currentRide(); }
export function elevatorQueueLength(id: ElevatorId = "A") { return controllers[id].queueLength(); }
export function canAcceptElevator(ride: ElevatorRide, id: ElevatorId = ride.elevatorId ?? "A") {
  return !GLASS_ELEVATORS.some(g => controllers[g.id].hasRider(ride.riderId)) && controllers[id].canAccept(ride);
}
export function requestElevator(ride: ElevatorRide, id: ElevatorId = ride.elevatorId ?? "A") {
  if (GLASS_ELEVATORS.some(g => controllers[g.id].hasRider(ride.riderId))) return "already";
  return controllers[id].request(ride);
}
export function getElevatorWaitingSlot(riderId: string, id: ElevatorId = "A") { return controllers[id].waitingSlot(riderId); }
/** Reserve a landing spot only; the cab is not called until `requestElevator`. */
export function reserveElevatorWaitingSlot(ride: ElevatorRide, id: ElevatorId = ride.elevatorId ?? "A") {
  if (GLASS_ELEVATORS.some(g => g.id !== id && controllers[g.id].hasRider(ride.riderId))) return null;
  return controllers[id].reserveWaitingSlot(ride);
}
export function getElevatorStandingPosition(riderId: string, id: ElevatorId = "A") { return controllers[id].standingPosition(riderId); }
export function canBoardElevator(riderId: string, id: ElevatorId = "A") { return controllers[id].canBoard(riderId); }
export function confirmElevatorBoarded(riderId: string, id: ElevatorId = "A") { return controllers[id].confirmBoarded(riderId); }
export function canExitElevator(riderId: string, id: ElevatorId = "A") { return controllers[id].canExit(riderId); }
export function confirmElevatorExited(riderId: string, id: ElevatorId = "A") { return controllers[id].confirmExited(riderId); }
export function cancelElevator(riderId: string, id: ElevatorId = "A") { return controllers[id].cancel(riderId); }
export function releaseElevator(riderId: string, id: ElevatorId = "A") { return controllers[id].release(riderId); }
export function resetElevator(id: ElevatorId = "A") { controllers[id].reset(); }
export function tickElevator(delta: number, id: ElevatorId = "A") { controllers[id].tick(delta); }
export function selectAvailableElevator(fromFloor: ElevatorFloor = 1): ElevatorId | null {
  let selected: ElevatorId | null = null, distance = Infinity;
  for (const lift of GLASS_ELEVATORS) {
    if (controllers[lift.id].busy()) continue;
    const candidate = Math.abs(controllers[lift.id].snapshot().y - floorElevation(fromFloor));
    if (candidate < distance) { distance = candidate; selected = lift.id; }
  }
  return selected;
}
