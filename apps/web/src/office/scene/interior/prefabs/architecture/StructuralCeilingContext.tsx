import { createContext, useContext, type ReactNode } from "react";
import { ceilingMountsForFloor, ceilingYForFloor, type CeilingFloor } from "./ceilingMounting";

const CeilingFloorContext = createContext<CeilingFloor>(1);
export function StructuralCeilingProvider({ floor, children }: { floor: CeilingFloor; children: ReactNode }) {
  return <CeilingFloorContext.Provider value={floor}>{children}</CeilingFloorContext.Provider>;
}
export function useStructuralCeiling() {
  const floor = useContext(CeilingFloorContext);
  return { floor, ceilingY: ceilingYForFloor(floor), mounts: ceilingMountsForFloor(floor) };
}
