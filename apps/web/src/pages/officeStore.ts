import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OfficeViewState {
  activeFloor: number;
  selectedAgentId: string | null;
  quality: 'low' | 'medium' | 'high';
  setFloor: (floor: number) => void;
  selectAgent: (agentId: string | null) => void;
  setQuality: (quality: 'low' | 'medium' | 'high') => void;
}

/**
 * Global Zustand Store for the 3D Virtual Office viewport.
 * Persists floor selection, quality, and inspect target across Web & Electron.
 */
export const useOfficeViewStore = create<OfficeViewState>()(
  persist(
    set => ({
      activeFloor: 1,
      selectedAgentId: null,
      quality: 'high',
      setFloor: floor => set({ activeFloor: floor }),
      selectAgent: agentId => set({ selectedAgentId: agentId }),
      setQuality: quality => set({ quality })
    }),
    {
      name: 'extalia.office.viewport.v1',
      version: 1
    }
  )
);
