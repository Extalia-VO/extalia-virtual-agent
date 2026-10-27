import { createContext, useContext, type ReactNode } from "react";
import { StaticCampusBatch } from "../StaticCampusBatch";

const ExteriorEnvelopeContext = createContext(false);

/** The campus skin owns perimeter surfaces only while the complete envelope is displayed. */
export function ExteriorEnvelopeProvider({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return <ExteriorEnvelopeContext.Provider value={hidden}>{children}</ExteriorEnvelopeContext.Provider>;
}

export function useExteriorEnvelopeActive() {
  return useContext(ExteriorEnvelopeContext);
}

/** Keep toggled wall buffers separate from the floor-wide immutable batch. */
export function EnvelopeWall({ exterior, name = "perimeter", children }: {
  exterior: boolean; name?: string; children: ReactNode;
}) {
  const hidden = useContext(ExteriorEnvelopeContext);
  if (!exterior) return <>{children}</>;
  return <group name={`room-envelope:${name}`} visible={!hidden}
    userData={{ officeDynamic: true, officeEnvelopeWall: true }}>
    <StaticCampusBatch>{children}</StaticCampusBatch>
  </group>;
}
