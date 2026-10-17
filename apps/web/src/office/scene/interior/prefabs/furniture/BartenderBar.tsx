import * as THREE from "three";
import { CoffeeMachine } from "../props/CoffeeMachine";
import { BARTENDER_BAR_BLUEPRINT } from "../../spatialBlueprints";
import { useSolarEnvironment } from "../../../Environment";
import { FixtureSpotLight } from "../architecture/FixtureSpotLight";
import { UNDER_STAIR_SOFFIT_Y } from "../architecture/ceilingMounting";

function StemwareRackLight() {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  return <group userData={{ officeCollision: false }}>
    <mesh position={[0, -0.04, 0]} userData={{ officeMaterialDynamic: "stemware-strip:interior:#ffe1b0:factor*1.3" }}>
      <boxGeometry args={[3.6, 0.01, 0.4]} />
      <meshStandardMaterial color="#eee2cd" emissive="#ffe1b0" emissiveIntensity={factor * 1.3} roughness={0.4} toneMapped={false} />
    </mesh>
    {[-1.1, 1.1].map(x => <FixtureSpotLight key={x} name="stemware-counter-downlight"
      position={[x, -0.065, 0]} aim={[x, -1.5, 0.3]} intensity={factor * 12} distance={4} angle={0.95} color="#ffe1b0" />)}
  </group>;
}

/** Under-stair soffit lighting for the bar service aisle, rear alcove, and east staff entrance under the landing. */
function UnderStairBarServiceLighting() {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const soffitY = UNDER_STAIR_SOFFIT_Y;
  // Local coordinates relative to bar root [3.2, 0, -6.3] in lounge [14.2, -0.9] -> world [17.4, 0, -7.2]:
  // Covers aisle west (-1.3), mid (0.5), east (2.3), alcove (4.0), bar-back (5.4), entry (6.8), approach (6.8, z=1.8).
  const fixtures = [
    { x: -1.3, z: -0.2, name: "bar-staff-downlight-west" },
    { x: 0.5, z: -0.2, name: "bar-staff-downlight-mid" },
    { x: 2.3, z: -0.2, name: "bar-staff-downlight-east" },
    { x: 4.0, z: -0.5, name: "bar-staff-downlight-alcove" },
    { x: 5.4, z: -0.5, name: "bar-staff-downlight-back" },
    { x: 6.8, z: -0.5, name: "bar-staff-downlight-entry" },
    { x: 6.8, z: 1.8, name: "bar-staff-downlight-approach" }
  ];
  return <group userData={{ officeCollision: false }}>
    {fixtures.map(f => (
      <group key={f.name} position={[f.x, soffitY, f.z]}>
        <mesh position={[0, -0.015, 0]}>
          <cylinderGeometry args={[0.09, 0.09, 0.03, 12]} />
          <meshStandardMaterial color="#4a5054" roughness={0.4} metalness={0.6} />
        </mesh>
        <mesh position={[0, -0.03, 0]} userData={{ officeMaterialDynamic: "bar-soffit-lens:interior:#ffe4c4:factor*1.2" }}>
          <cylinderGeometry args={[0.075, 0.075, 0.01, 12]} />
          <meshStandardMaterial color="#eee6dc" emissive="#ffe4c4" emissiveIntensity={factor * 1.2} roughness={0.4} toneMapped={false} />
        </mesh>
        <FixtureSpotLight
          name={f.name}
          position={[0, -0.04, 0]}
          aim={[0, -2.8, 0]}
          intensity={factor * 20}
          distance={3.8}
          angle={0.92}
          color="#ffe4c4"
        />
      </group>
    ))}
  </group>;
}

// Reusable geometries
const stoolSeatGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.08, 16);
const stoolStemGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.65, 8);
const stoolBaseGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.03, 16);
const stoolFootrestGeo = new THREE.TorusGeometry(0.18, 0.016, 8, 16);

export function BarStool({
  position = [0, 0, 0],
  rotationY = 0,
  cushionColor = "#cf8e59"
}: {
  position?: [number, number, number];
  rotationY?: number;
  cushionColor?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      {/* Base */}
      <mesh castShadow receiveShadow position={[0, 0.02, 0]} geometry={stoolBaseGeo}>
        <meshStandardMaterial color="#222629" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Central Post */}
      <mesh castShadow position={[0, 0.35, 0]} geometry={stoolStemGeo}>
        <meshStandardMaterial color="#33383c" metalness={0.8} roughness={0.25} />
      </mesh>
      {/* Footrest Ring */}
      <mesh castShadow position={[0, 0.26, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={stoolFootrestGeo}>
        <meshStandardMaterial color="#444a50" metalness={0.8} roughness={0.25} />
      </mesh>
      {/* Padded Seat */}
      <mesh castShadow position={[0, 0.72, 0]} geometry={stoolSeatGeo}>
        <meshStandardMaterial color={cushionColor} roughness={0.7} />
      </mesh>
      {/* Low lumbar curve */}
      <mesh castShadow position={[0, 0.84, 0.16]} rotation={[-0.2, 0, 0]}>
        <boxGeometry args={[0.34, 0.16, 0.05]} />
        <meshStandardMaterial color={cushionColor} roughness={0.7} />
      </mesh>
    </group>
  );
}

/**
 * BartenderCounter:
 * Premium L-shaped or linear Bar & Pantry station with:
 * - Back-bar back-counter with wooden/stone cabinets and glassware/syrup display shelves
 * - Overhead hanging wine/glass rack with warm LED accent glow
 * - Espresso machine, tea kettle, beverage taps, cup stack, sink
 * - Front marble service counter with transaction ledge and footrest
 * - Bar stools for agents to sit and sip drinks / chat with bartender
 *
 * Placement: F1 under-stair alcove beneath the intermediate landing. Every
 * child (back bar, shelves, rack, counter, stools) inherits the blueprint root,
 * so render geometry and the lounge.bartender / lounge.barstool-* anchors move
 * together.
 */
export function BartenderBar() {
  const suspensionTop = UNDER_STAIR_SOFFIT_Y - BARTENDER_BAR_BLUEPRINT.stemwareRack.position[1] - 0.04;
  const suspensionBottom = 0.03;
  return (
    <group position={BARTENDER_BAR_BLUEPRINT.rootPosition} rotation={[0, BARTENDER_BAR_BLUEPRINT.rotationY, 0]} userData={{ officeSeatStation: true }}>
      <UnderStairBarServiceLighting />
      {/* ============================================================ */}
      {/* 1. BACK BAR (Menempel di dinding dekat tangga)               */}
      {/* ============================================================ */}
      <group position={BARTENDER_BAR_BLUEPRINT.backBar.position}>
        {/* Back Cabinet Base (Storage for syrups, fridge, cups) */}
        {/* Shallow cabinet keeps a full body-width service aisle in front of it. */}
        <mesh castShadow receiveShadow position={[0, 0.46, -0.06]}>
          <boxGeometry args={[4.4, 0.92, 0.53]} />
          <meshStandardMaterial color="#2d2824" roughness={0.8} />
        </mesh>
        {/* Back Cabinet Dark Stone Countertop */}
        <mesh castShadow receiveShadow position={[0, 0.93, -0.06]}>
          <boxGeometry args={[4.44, 0.05, 0.58]} />
          <meshStandardMaterial color="#1a1c1e" roughness={0.4} metalness={0.2} />
        </mesh>

        {/* Back Wall Feature Panel with Wood Slats & Mirror / Bronze Backing */}
        <mesh position={[0, 1.95, -0.32]}>
          <boxGeometry args={[4.4, 2.0, 0.04]} />
          <meshStandardMaterial color="#3a322c" roughness={0.85} />
        </mesh>

        {/* Overhead Shelving Unit (Upper shelves for bottles, cups, tea canisters) */}
        {/* Shelf Tier 1 */}
        <mesh castShadow position={[0, 1.45, -0.15]}>
          <boxGeometry args={[4.2, 0.04, 0.32]} />
          <meshStandardMaterial color="#c29864" metalness={0.4} roughness={0.5} />
        </mesh>
        {/* Shelf Tier 2 */}
        <mesh castShadow position={[0, 1.95, -0.15]}>
          <boxGeometry args={[4.2, 0.04, 0.32]} />
          <meshStandardMaterial color="#c29864" metalness={0.4} roughness={0.5} />
        </mesh>
        {/* Shelf Tier 3 (Top) */}
        <mesh castShadow position={[0, 2.45, -0.15]}>
          <boxGeometry args={[4.2, 0.04, 0.32]} />
          <meshStandardMaterial color="#c29864" metalness={0.4} roughness={0.5} />
        </mesh>

        {/* Shelf Bracket Rails (Black metal frame) */}
        {[-1.9, -0.7, 0.7, 1.9].map((rx) => (
          <mesh key={`shelf-rail-${rx}`} castShadow position={[rx, 1.95, -0.15]}>
            <boxGeometry args={[0.04, 1.1, 0.3]} />
            <meshStandardMaterial color="#1c2022" metalness={0.7} roughness={0.3} />
          </mesh>
        ))}

        {/* Decorative Bottles and Syrups on Shelves */}
        {[-1.6, -1.3, -1.0, -0.3, 0.0, 0.3, 1.1, 1.4, 1.7].map((bx, idx) => {
          const colors = ["#b5651d", "#2e8b57", "#8b0000", "#daa520", "#4682b4", "#556b2f"];
          const bColor = colors[idx % colors.length];
          const height = 0.24 + (idx % 3) * 0.04;
          return (
            <mesh key={`bottle-t1-${bx}`} castShadow position={[bx, 1.47 + height / 2, -0.15]}>
              <cylinderGeometry args={[0.04, 0.045, height, 10]} />
              <meshStandardMaterial color={bColor} roughness={0.2} metalness={0.1} />
            </mesh>
          );
        })}

        {/* Coffee Bean Canisters and Tea Jars on Tier 2 */}
        {[-1.5, -1.1, -0.7, 0.8, 1.2, 1.6].map((jx, idx) => (
          <mesh key={`jar-t2-${jx}`} castShadow position={[jx, 2.07, -0.15]}>
            <cylinderGeometry args={[0.07, 0.07, 0.20, 12]} />
            <meshStandardMaterial color={idx % 2 === 0 ? "#ded5c5" : "#3b332b"} roughness={0.6} />
          </mesh>
        ))}

        {/* Appliances on Back Counter: Coffee Machine, Water Dispenser, Cup Stacks */}
        <CoffeeMachine position={[-1.2, 0.95, 0.0]} />
        {/* Tea Kettle & Hot Water Pot */}
        <mesh castShadow position={[-0.3, 1.08, 0.0]}>
          <cylinderGeometry args={[0.1, 0.12, 0.22, 12]} />
          <meshStandardMaterial color="#d4af37" metalness={0.8} roughness={0.3} />
        </mesh>
        {/* Glass Cup Stacks */}
        {[-0.65, 0.5, 0.75].map((cx) => (
          <mesh key={`cup-stack-${cx}`} castShadow position={[cx, 1.05, 0.02]}>
            <cylinderGeometry args={[0.065, 0.05, 0.18, 10]} />
            <meshStandardMaterial color="#e0f2f1" transparent opacity={0.7} roughness={0.1} />
          </mesh>
        ))}
        {/* Under-counter bar sink */}
        <mesh position={[1.4, 0.95, 0.0]}>
          <boxGeometry args={[0.55, 0.02, 0.45]} />
          <meshStandardMaterial color="#4a5257" metalness={0.9} roughness={0.2} />
        </mesh>
        {/* Chrome Goose-neck Faucet */}
        <mesh position={[1.4, 1.15, -0.16]}>
          <torusGeometry args={[0.1, 0.018, 8, 16, Math.PI]} />
          <meshStandardMaterial color="#e8eaeb" metalness={0.95} roughness={0.15} />
        </mesh>
      </group>

      {/* ============================================================ */}
      {/* 2. OVERHEAD HANGING STEMWARE RACK WITH ACCENT LIGHT          */}
      {/* ============================================================ */}
      <group position={BARTENDER_BAR_BLUEPRINT.stemwareRack.position}>
        {/* Rack Frame */}
        <mesh castShadow position={[0, 0, 0]}>
          <boxGeometry args={[3.8, 0.06, 0.5]} />
          <meshStandardMaterial color="#1a1c1e" metalness={0.8} roughness={0.3} />
        </mesh>
        {/* Vertical suspension rods from ceiling */}
        {[-1.6, 1.6].map((rodX) => (
          <group key={`rod-${rodX}`}>
            <mesh position={[rodX, (suspensionTop + suspensionBottom) / 2, 0]}>
              <cylinderGeometry args={[0.02, 0.02, suspensionTop - suspensionBottom, 8]} />
              <meshStandardMaterial color="#1a1c1e" metalness={0.8} roughness={0.3} />
            </mesh>
            <mesh position={[rodX, UNDER_STAIR_SOFFIT_Y - BARTENDER_BAR_BLUEPRINT.stemwareRack.position[1] - 0.02, 0]}>
              <cylinderGeometry args={[0.045, 0.045, 0.04, 8]} />
              <meshStandardMaterial color="#1a1c1e" metalness={0.8} roughness={0.3} />
            </mesh>
          </group>
        ))}
        {/* Glassware Stemware silhouette */}
        {[-1.4, -1.0, -0.6, 0.6, 1.0, 1.4].map((gx) => (
          <mesh key={`stemware-${gx}`} position={[gx, -0.1, 0]}>
            <cylinderGeometry args={[0.04, 0.015, 0.16, 8]} />
            <meshStandardMaterial color="#ffffff" transparent opacity={0.5} roughness={0.2} />
          </mesh>
        ))}
        <StemwareRackLight />
      </group>

      {/* ============================================================ */}
      {/* 3. FRONT SERVICE BAR & COUNTER (Untuk Bartender & Tamu)      */}
      {/* ============================================================ */}
      <group position={BARTENDER_BAR_BLUEPRINT.frontCounter.position}>
        {/* Lower Counter Body (Warm slatted oak / dark walnut front) */}
        <mesh castShadow receiveShadow position={BARTENDER_BAR_BLUEPRINT.frontCounter.bodyPosition}>
          <boxGeometry args={BARTENDER_BAR_BLUEPRINT.frontCounter.bodySize} />
          <meshStandardMaterial color="#2d2824" roughness={0.7} />
        </mesh>
        {/* Front Fluted Wood Trim Panel Facing the Guests */}
        <mesh castShadow position={[0, 0.55, 0.36]}>
          <boxGeometry args={[4.16, 1.06, 0.03]} />
          <meshStandardMaterial color="#4a3b32" roughness={0.85} />
        </mesh>
        {/* Warm Under-ledge Cove LED Strip */}
        <mesh position={[0, 1.13, 0.42]}>
          <boxGeometry args={[4.1, 0.015, 0.02]} />
          <meshBasicMaterial color="#ffa84d" />
        </mesh>
        {/* Brass Footrest Rail for Guests on the Bar Stools */}
        <mesh castShadow position={[0, 0.22, 0.48]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.025, 0.025, 4.0, 12]} />
          <meshStandardMaterial color="#d4af37" metalness={0.85} roughness={0.25} />
        </mesh>
        {[-1.8, -0.9, 0, 0.9, 1.8].map((fx) => (
          <mesh key={`footrest-bracket-${fx}`} position={[fx, 0.14, 0.42]}>
            <boxGeometry args={[0.03, 0.22, 0.14]} />
            <meshStandardMaterial color="#222" metalness={0.7} roughness={0.3} />
          </mesh>
        ))}

        {/* Countertop: Wide Premium Calacatta Marble with Beveled Edge */}
        <mesh castShadow receiveShadow position={[
          BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.center[0],
          BARTENDER_BAR_BLUEPRINT.frontCounter.countertopY,
          BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.center[1]
        ]}>
          <boxGeometry args={[
            BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.size[0],
            BARTENDER_BAR_BLUEPRINT.frontCounter.countertopThickness,
            BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.size[1]
          ]} />
          <meshStandardMaterial color="#f0ede6" roughness={0.3} metalness={0.1} />
        </mesh>
        {/* Raised Wooden Serving Transaction Ledge for Drinks */}
        <mesh castShadow position={[0, 1.16, 0.25]}>
          <boxGeometry args={[4.2, 0.03, 0.35]} />
          <meshStandardMaterial color="#c29864" roughness={0.5} metalness={0.2} />
        </mesh>

        {/* Bar Top Accessories: Bar menu stand, pastry cloche display, water carafe */}
        {/* Glass pastry dome / display case */}
        <mesh castShadow position={[1.5, 1.25, 0.0]}>
          <sphereGeometry args={[0.16, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#e0f2f1" transparent opacity={0.6} roughness={0.1} />
        </mesh>
        {/* Menu chalkboard stand */}
        <mesh castShadow position={[-1.7, 1.26, 0.1]} rotation={[0, 0.2, 0]}>
          <boxGeometry args={[0.18, 0.24, 0.03]} />
          <meshStandardMaterial color="#1a1c1e" roughness={0.9} />
        </mesh>
      </group>

      {/* ============================================================ */}
      {/* 4. BAR STOOLS (Depan Meja Bar menghadap Bartender / ke Utara) */}
      {/* ============================================================ */}
      {BARTENDER_BAR_BLUEPRINT.stools.map((stool) => {
        return (
          <BarStool
            key={stool.resourceId}
            position={[...stool.position]}
            rotationY={stool.rotationY}
            cushionColor={stool.cushionColor}
          />
        );
      })}
    </group>
  );
}
