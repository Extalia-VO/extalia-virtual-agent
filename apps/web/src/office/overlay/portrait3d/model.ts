import type { CharacterAppearance } from '@extalia/core';
import type { OfficeAgent } from '../../presence';
import { lookSeed, resolvedAppearance, type LookIdentity } from '../../scene/avatars/appearance';
import type { CharacterMotion } from '../../scene/movement/walkCycle';

export type PortraitActivity = Pick<OfficeAgent, 'status' | 'running' | 'control' | 'live' | 'activity' | 'phase' | 'earlier' | 'pendingApprovalId'>;

export interface PortraitSubject {
  characterId: string;
  appearance?: CharacterAppearance;
  identity?: LookIdentity;
  activity?: PortraitActivity;
  motion?: CharacterMotion;
}

/** Appearance keys do not depend on the insertion order of saved JSON fields. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function portraitSubject(subject: PortraitSubject) {
  const id = lookSeed(subject.characterId, subject.identity);
  const appearance = resolvedAppearance(subject.characterId, subject.appearance, subject.identity);
  return { id, appearance, key: JSON.stringify([subject.characterId, id, stable(appearance)]) };
}

export const PORTRAIT_FRAME_MS = 1000 / 15;
const THUMBNAIL_FRAME_MS = 1000 / 10;
const THUMBNAIL_MAX_CSS_SIZE = 64;

/** Hidden targets are omitted by the renderer. A dialog or other large view
 * keeps the shared renderer at full cadence; board thumbnails use less GPU work.
 */
export function portraitFrameInterval(visibleSizes: readonly { width: number; height: number }[]): number {
  return visibleSizes.length > 0 && visibleSizes.every(size =>
    Number.isFinite(size.width) && Number.isFinite(size.height) &&
    Math.max(size.width, size.height) <= THUMBNAIL_MAX_CSS_SIZE)
    ? THUMBNAIL_FRAME_MS : PORTRAIT_FRAME_MS;
}
