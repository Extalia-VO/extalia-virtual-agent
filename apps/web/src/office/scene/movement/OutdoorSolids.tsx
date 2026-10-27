/** Structural body-height collision proxies; canopy ribs never become solid walls. */
type Solid = { readonly position: readonly [number, number, number]; readonly size: readonly [number, number, number] };
export const OUTDOOR_SOLIDS = {
  // The front coping is a supported seating lip. The planted body remains solid
  // behind it, while the actual seat slats retain their individual contact owners.
  planter: [{ position: [0, .28, .25], size: [6.4, .56, 2.1] }],
  'picnic-table': [
    { position: [0, .72, 0], size: [1.92, .05, .60] },
    { position: [-.72, .36, 0], size: [.09, .72, .86] },
    { position: [.72, .36, 0], size: [.09, .72, .86] },
  ],
  parasol: [{ position: [0, 1.3, 0], size: [.08, 2.6, .08] }],
  'patio-table': [
    { position: [0, .8, 0], size: [1.28, .05, 1.28] },
    { position: [0, .38, 0], size: [.20, .76, .20] },
    { position: [.02, 1.3, 0], size: [.07, 2.6, .07] },
  ],
} as const satisfies Record<string, readonly Solid[]>;

export type OutdoorSolidKind = keyof typeof OUTDOOR_SOLIDS;

/** Material-hidden meshes stay in collision queries and out of render batching. */
export function OutdoorSolids({ kind }: { kind: OutdoorSolidKind }) {
  return <group name={`outdoor-structural-${kind}`}>
    {OUTDOOR_SOLIDS[kind].map((solid, index) => <mesh key={index} position={[...solid.position]}
      userData={{ officeDynamic: true }} raycast={() => {}}>
      <boxGeometry args={[...solid.size]} />
      <meshBasicMaterial visible={false} />
    </mesh>)}
  </group>;
}
