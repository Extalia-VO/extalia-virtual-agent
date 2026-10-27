import { create } from 'zustand';
import type { PageId } from '../i18n';
import type { FurnishedOfficeView } from './scene/FurnishedFloors';
import { loadLightOverride, saveLightOverride, type LightOverride } from './scene/environment/lightOverride';

/**
 * The Office floor view and interior lights: one source shared by the App top bar
 * (which draws the controls) and the Office page / scene (which follow them).
 * The view lasts for this app session; the light choice is remembered per device.
 */
export interface OfficeControlsState {
  view: FurnishedOfficeView;
  /** Explicit view requests hand camera control back to the user; automatic follow updates do not. */
  viewRequest: number;
  lightOverride: LightOverride;
  setView(view: FurnishedOfficeView): void;
  followFloor(floor: 1 | 2 | 3): void;
  setLightOverride(mode: LightOverride): void;
}

export const useOfficeControls = create<OfficeControlsState>()(set => ({
  view: 'campus',
  viewRequest: 0,
  lightOverride: loadLightOverride(),
  setView: view => set(state => ({ view, viewRequest: state.viewRequest + 1 })),
  followFloor: view => set(state => state.view === view ? state : { view }),
  setLightOverride: mode => { saveLightOverride(mode); set({ lightOverride: mode }); },
}));

export const OFFICE_VIEWS: readonly FurnishedOfficeView[] = ['campus', 1, 2, 3, 'stack'];

/** Floor and light controls belong to the 3D Office only; no other page shows them. */
export function showsOfficeControls(page: PageId): boolean {
  return page === 'office';
}

/** Arrow/Home/End movement inside a button group; undefined for other keys. */
export function groupFocusTarget(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}
