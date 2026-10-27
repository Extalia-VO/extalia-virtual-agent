import { WorkstationPart } from './WorkstationPart';
import { SINGLE_WORKSTATION_BLUEPRINT as DESK } from './spatialBlueprints';

/** The authored desk stays independent of the chair, personalized accessories and live devices. */
export function SingleDeskStructure({ color = '#a77e58' }: { color?: string }) {
  return <WorkstationPart asset="single-desk" woodColor={color === '#a77e58' || color === '#ad845f' ? undefined : color}>
    <mesh castShadow receiveShadow position={[0, DESK.topY, 0]}>
      <boxGeometry args={DESK.topSize} /><meshStandardMaterial color={color} roughness={.76} />
    </mesh>
    {DESK.legXs.map(x => <mesh key={x} castShadow position={[x, DESK.legY, 0]}>
      <boxGeometry args={DESK.legSize} /><meshStandardMaterial color="#637174" roughness={.62} />
    </mesh>)}
  </WorkstationPart>;
}
