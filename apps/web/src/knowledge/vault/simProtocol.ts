/**
 * Messages between the vault graph view and its force simulation (a Web Worker, or the same code
 * on the main thread when workers are unavailable). Arrays travel as transferables: the worker
 * hands over a fresh positions buffer per frame (x, y, z per node) and never reads it again.
 */

export type SimCommand =
  | { type: 'init'; count: number; edges: Uint32Array; degree: Uint32Array; seed?: Float32Array }
  | { type: 'mask'; active: Uint8Array }
  | { type: 'drag'; index: number; x: number; y: number; z: number }
  | { type: 'release'; index: number }
  | { type: 'reheat'; alpha: number }
  | { type: 'pause' }
  | { type: 'resume' };

export interface SimFrame { type: 'positions'; positions: Float32Array; alpha: number; running: boolean }

/** At most this many position frames per second reach the renderer (it eases between them). */
export const SIM_POST_HZ = 30;
/** Cooling: the simulation stops below this alpha. */
export const SIM_ALPHA_MIN = 0.004;
/** Alpha a filter change or drag restarts with: a brief settle, not a new layout. */
export const SIM_REHEAT_ALPHA = 0.35;

/** A message and the buffers to transfer with it (the sender must not use them afterwards). */
export interface Encoded<T> { message: T; transfer: Transferable[] }

export function encodeInit(count: number, edges: Uint32Array, degree: Uint32Array, seed?: Float32Array): Encoded<SimCommand> {
  // Copies, so the caller keeps its own arrays for drawing.
  const message: SimCommand = { type: 'init', count, edges: edges.slice(), degree: degree.slice(), ...(seed ? { seed: seed.slice() } : {}) };
  const transfer: Transferable[] = [message.edges.buffer, message.degree.buffer];
  if (message.seed) transfer.push(message.seed.buffer);
  return { message, transfer };
}

export function encodeMask(active: Uint8Array): Encoded<SimCommand> {
  const copy = active.slice();
  return { message: { type: 'mask', active: copy }, transfer: [copy.buffer] };
}

export function encodeFrame(positions: Float32Array, alpha: number, running: boolean): Encoded<SimFrame> {
  return { message: { type: 'positions', positions, alpha, running }, transfer: [positions.buffer] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const index = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Validate a command received by the simulation; anything malformed is ignored (`null`). */
export function decodeCommand(data: unknown): SimCommand | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'init': {
      const { count, edges, degree, seed } = data;
      if (!index(count) || !(edges instanceof Uint32Array) || edges.length % 2 || !(degree instanceof Uint32Array) || degree.length !== count) return null;
      for (const at of edges) if (at >= count) return null;
      if (seed !== undefined && (!(seed instanceof Float32Array) || seed.length !== count * 3)) return null;
      return { type: 'init', count, edges, degree, ...(seed ? { seed } : {}) };
    }
    case 'mask': return data.active instanceof Uint8Array ? { type: 'mask', active: data.active } : null;
    case 'drag': return index(data.index) && finite(data.x) && finite(data.y) && finite(data.z) ? { type: 'drag', index: data.index, x: data.x, y: data.y, z: data.z } : null;
    case 'release': return index(data.index) ? { type: 'release', index: data.index } : null;
    case 'reheat': return finite(data.alpha) && data.alpha > 0 && data.alpha <= 1 ? { type: 'reheat', alpha: data.alpha } : null;
    case 'pause': case 'resume': return { type: data.type };
    default: return null;
  }
}

/** Validate a frame received by the view (`count` nodes expected). */
export function decodeFrame(data: unknown, count: number): SimFrame | null {
  if (!isRecord(data) || data.type !== 'positions' || !(data.positions instanceof Float32Array) || data.positions.length !== count * 3) return null;
  if (!finite(data.alpha) || typeof data.running !== 'boolean') return null;
  return { type: 'positions', positions: data.positions, alpha: data.alpha, running: data.running };
}
