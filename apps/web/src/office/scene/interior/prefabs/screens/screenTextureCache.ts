/**
 * Shared, reference-counted screen surfaces with a throttled live update.
 *
 * Screens with the same content key share one surface (canvas + GPU texture). A static surface is
 * painted once. A live surface is repainted at most every `minIntervalMs` (500 ms, i.e. 2 Hz), only
 * while at least one of its screens is on screen, and at most `budgetPerTick` surfaces per call so a
 * burst of due repaints is spread over several frames instead of stalling one.
 *
 * DOM-free: the host creates, paints and disposes the surface, so the policy is unit-testable.
 */

export interface TextureSpecLike { key: string; liveMs: number }

export interface TextureHost<S, P extends TextureSpecLike> {
  create(spec: P): S;
  paint(surface: S, spec: P, now: number, frame: number): void;
  dispose(surface: S): void;
}

export interface TextureConsumer<S> {
  /** Cheap check, evaluated only when a repaint is due: is any part of this screen in view? */
  isVisible(): boolean;
  /** After every paint (and once on retain) so the owner can refresh its light emitter. */
  onPaint?(surface: S): void;
}

interface Entry<S, P extends TextureSpecLike, C> {
  spec: P;
  surface: S;
  consumers: Set<C>;
  frame: number;
  nextPaint: number;
  paints: number;
  /** Last time this entry was obtained, retained or released; drives the idle sweep. */
  touched: number;
}

export interface TextureCacheOptions {
  /** How long an unreferenced surface is kept for quick reuse before it is disposed. */
  graceMs?: number;
  minIntervalMs?: number;
  budgetPerTick?: number;
  /** Millisecond clock used when a call does not pass its own time. */
  clock?: () => number;
}

export interface TextureCacheStats {
  entries: number;
  liveEntries: number;
  referencedEntries: number;
  consumers: number;
  totalPaints: number;
}

export class ScreenTextureCache<S, P extends TextureSpecLike, C extends TextureConsumer<S>> {
  private readonly entries = new Map<string, Entry<S, P, C>>();
  private readonly graceMs: number;
  private readonly minIntervalMs: number;
  private readonly budgetPerTick: number;
  private readonly clock: () => number;
  private totalPaints = 0;

  constructor(private readonly host: TextureHost<S, P>, options: TextureCacheOptions = {}) {
    this.graceMs = options.graceMs ?? 5000;
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.budgetPerTick = options.budgetPerTick ?? 2;
    this.clock = options.clock ?? (() => performance.now());
  }

  /** Get or create the surface for a spec (painting its first frame) without holding a reference. */
  obtain(spec: P, now: number = this.clock()): S {
    const entry = this.entries.get(spec.key) ?? this.create(spec, now);
    entry.touched = now;
    return entry.surface;
  }

  /** Hold the surface for `consumer`; call the returned function to let go. */
  retain(key: string, consumer: C, now: number = this.clock()): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.consumers.add(consumer);
    entry.touched = now;
    consumer.onPaint?.(entry.surface);
    return () => {
      const current = this.entries.get(key);
      if (!current) return;
      current.consumers.delete(consumer);
      current.touched = this.clock();
    };
  }

  /** Repaint due live surfaces that are in view and dispose surfaces nobody has wanted for a while. */
  tick(now: number = this.clock(), isVisible: (consumer: C) => boolean = consumer => consumer.isVisible()): number {
    const due: Entry<S, P, C>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.consumers.size === 0 && now - entry.touched > this.graceMs) {
        this.host.dispose(entry.surface);
        this.entries.delete(entry.spec.key);
      } else if (entry.nextPaint <= now && entry.consumers.size > 0) {
        due.push(entry);
      }
    }
    due.sort((a, b) => a.nextPaint - b.nextPaint);
    let painted = 0;
    for (const entry of due) {
      if (painted >= this.budgetPerTick) break;
      let visible = false;
      for (const consumer of entry.consumers) { if (isVisible(consumer)) { visible = true; break; } }
      if (!visible) { entry.nextPaint = now + this.minIntervalMs; continue; }
      this.paint(entry, now);
      painted++;
    }
    return painted;
  }

  stats(): TextureCacheStats {
    let liveEntries = 0, referenced = 0, consumers = 0;
    for (const entry of this.entries.values()) {
      if (Number.isFinite(entry.nextPaint)) liveEntries++;
      if (entry.consumers.size) referenced++;
      consumers += entry.consumers.size;
    }
    return { entries: this.entries.size, liveEntries, referencedEntries: referenced, consumers, totalPaints: this.totalPaints };
  }

  has(key: string): boolean { return this.entries.has(key); }
  /** Paint counts per key, for diagnostics. */
  paintCounts(): Record<string, number> {
    return Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.paints]));
  }

  clear(): void {
    for (const entry of this.entries.values()) this.host.dispose(entry.surface);
    this.entries.clear();
  }

  private create(spec: P, now: number): Entry<S, P, C> {
    const entry: Entry<S, P, C> = {
      spec, surface: this.host.create(spec), consumers: new Set(), frame: 0, nextPaint: Infinity, paints: 0, touched: now,
    };
    this.entries.set(spec.key, entry);
    this.paint(entry, now);
    return entry;
  }

  private paint(entry: Entry<S, P, C>, now: number): void {
    this.host.paint(entry.surface, entry.spec, now, entry.frame++);
    entry.paints++;
    this.totalPaints++;
    entry.nextPaint = entry.spec.liveMs > 0 ? now + Math.max(entry.spec.liveMs, this.minIntervalMs) : Infinity;
    for (const consumer of entry.consumers) consumer.onPaint?.(entry.surface);
  }
}
