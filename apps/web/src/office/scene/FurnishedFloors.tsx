import type { OfficeAgent } from '../presence';
import type { Language } from '../../i18n';
import { Floor1 } from './Floor1';
import { Floor2 } from './Floor2';
import { Floor3 } from './Floor3';
import { FLOOR_HEIGHT, OFFICE_STAIRCASE } from './layout';
import { StaticCampusBatch } from './StaticCampusBatch';
import { Staircase } from './prefabs/architecture/Staircase';
import { FurnishedFloorProvider } from './interior/FurnishedFloorContext';
import { FloorVisibilityProvider } from './interior/FloorVisibilityContext';
import { StructuralCeilingProvider } from './interior/prefabs/architecture/StructuralCeilingContext';
import { OfficeCeilings } from './interior/prefabs/architecture/OfficeCeilings';
import { FixtureLighting } from './interior/lighting/FixtureLighting';
export { allocateOfficeAgents, getOfficeSeats } from './interior/seating';
export type { OfficeSeat, OfficeAgentAllocation } from './interior/seating';

export type FurnishedOfficeView = 'campus' | 'stack' | 1 | 2 | 3;

/** Shared Desktop/Web room renderer; profiles and runtimes never enter the scene. */
export function FurnishedFloors({ view, agents, language }: {
  view: FurnishedOfficeView; agents: readonly OfficeAgent[]; language: Language;
}) {
  const all = view === 'campus' || view === 'stack';
  return <FurnishedFloorProvider agents={agents} language={language}>
    <FixtureLighting />
    {([1, 2, 3] as const).map(floor => <FloorVisibilityProvider key={floor} value={view === floor}>
      <group visible={all || view === floor} position={[0, (floor - 1) * FLOOR_HEIGHT, 0]} name={`furnished-floor-${floor}`}>
        <StructuralCeilingProvider floor={floor}>
          <StaticCampusBatch>
            <OfficeCeilings floor={floor} />
            {floor === 1 ? <Floor1 /> : floor === 2 ? <Floor2 /> : <Floor3 />}
          </StaticCampusBatch>
        </StructuralCeilingProvider>
      </group>
    </FloorVisibilityProvider>)}
      {([1, 2] as const).map(floor => <group key={floor} visible={all || view === floor || view === floor + 1}>
        <StaticCampusBatch><Staircase position={[OFFICE_STAIRCASE.x, (floor - 1) * FLOOR_HEIGHT, OFFICE_STAIRCASE.z]}
          width={OFFICE_STAIRCASE.width} rise={FLOOR_HEIGHT} runPerFlight={OFFICE_STAIRCASE.runPerFlight}
          stepsPerFlight={OFFICE_STAIRCASE.stepsPerFlight} midLandingDepth={OFFICE_STAIRCASE.midLandingDepth} /></StaticCampusBatch>
      </group>)}
  </FurnishedFloorProvider>;
}
