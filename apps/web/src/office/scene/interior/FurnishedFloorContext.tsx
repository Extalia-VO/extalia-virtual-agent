import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { OfficeAgent } from '../../presence';
import { officeInteriorText, type Language } from '../../../i18n';
import { allocateOfficeAgents, type OfficeAgentAllocation } from './seating';

export interface FurnishedFloorState {
  agents: readonly OfficeAgent[];
  allocations: readonly OfficeAgentAllocation[];
  language: Language;
}
const empty: FurnishedFloorState = { agents: [], allocations: [], language: 'en' };
const FurnishedContext = createContext<FurnishedFloorState>(empty);

/** All furniture sees the same real session projection as Chat and the office avatars. */
export function FurnishedFloorProvider({ agents, language, allocations: given, children }: {
  agents: readonly OfficeAgent[]; language: Language;
  /** The scene's seat allocation, so desks and characters agree; derived from `agents` when absent. */
  allocations?: readonly OfficeAgentAllocation[] | undefined;
  children: ReactNode;
}) {
  const allocations = useMemo(() => given ?? allocateOfficeAgents(agents), [agents, given]);
  const value = useMemo(() => ({ agents, allocations, language }), [agents, allocations, language]);
  return <FurnishedContext.Provider value={value}>{children}</FurnishedContext.Provider>;
}
export const useFurnishedFloorState = () => useContext(FurnishedContext);
export function useInteriorText() {
  const { language } = useFurnishedFloorState();
  return useCallback((text: string) => officeInteriorText(language, text), [language]);
}
export function useResourceVisualState(resourceId?: string): 'AVAILABLE' | 'OCCUPIED' {
  const { allocations } = useFurnishedFloorState();
  return allocations.some(allocation => allocation.resourceId === resourceId) ? 'OCCUPIED' : 'AVAILABLE';
}
export function useResourceOccupantKey(resourceId?: string): string | undefined {
  return useFurnishedFloorState().allocations.find(allocation => allocation.resourceId === resourceId)?.agentId;
}
/** Mug remains on its authored desk until interaction state is supplied by the renderer. */
export function useCoffeeCupHeldAtDesk(_resourceId?: string): boolean { return false; }
