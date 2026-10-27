import type { SmartScreenData } from "../../screenData";
import { WallDisplay } from "./WallDisplay";

/** Cooling, cable distribution, and live status equipment for Operations / Server. */
export function ServerRoomServiceDetails({ data }: { data: SmartScreenData }) {
  return (
    <group name="server-room-services">
      {/* Overhead cable ladder above the rack row, with short drops to each cabinet. */}
      <group position={[-2.6, 2.55, 0.3]}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.24, 0.075, 3.55]} />
          <meshStandardMaterial color="#34434a" metalness={0.76} roughness={0.32} />
        </mesh>
        {[-1.7, -1.1, -0.5, 0.1, 0.7, 1.3, 1.7].map((z) => (
          <mesh key={`ladder-${z}`} position={[0, 0.05, z]}>
            <boxGeometry args={[0.34, 0.025, 0.025]} />
            <meshStandardMaterial color="#86969b" metalness={0.8} roughness={0.28} />
          </mesh>
        ))}
        {[-0.9, 0.3, 1.5].map((z, index) => (
          <mesh key={`drop-${z}`} position={[index % 2 ? -0.09 : 0.09, -0.25, z - 0.3]}>
            <cylinderGeometry args={[0.025, 0.025, 0.42, 8]} />
            <meshStandardMaterial color={index === 1 ? "#46b8c6" : "#d1a65a"} metalness={0.42} roughness={0.4} />
          </mesh>
        ))}
      </group>

      {/* Perforated supply tiles feed the cold aisle; every grille stays flush with the access floor. */}
      {[-0.9, 0.3, 1.5].map(z => <group key={`supply-${z}`} position={[-1.7, 0.096, z]} userData={{ officeCollision: false }}>
        <mesh><boxGeometry args={[0.44, 0.008, 0.8]} /><meshStandardMaterial color="#233a43" metalness={0.64} roughness={0.5} /></mesh>
        {[-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map(slot => <mesh key={slot} position={[0, 0.005, slot]}><boxGeometry args={[0.36, 0.003, 0.027]} /><meshStandardMaterial color="#78949b" metalness={0.74} roughness={0.38} /></mesh>)}
      </group>)}
      {/* Ceiling service rails and cable color bands remain outside the walking volume. */}
      {[-2.86, -2.77].map((x, index) => <mesh key={x} position={[x, 2.62, 0.3]}>
        <boxGeometry args={[0.025, 0.035, 3.48]} /><meshStandardMaterial color={index ? "#d2a65a" : "#46b8c6"} roughness={0.55} />
      </mesh>)}
      <mesh position={[-0.35, 2.7, 0.3]} userData={{ officeCollision: false }}><boxGeometry args={[0.06, 0.025, 4.2]} /><meshStandardMaterial color="#b4e6ed" emissive="#77c6d5" emissiveIntensity={0.7} /></mesh>
      <mesh position={[-3.92, 1.95, 2.6]}><boxGeometry args={[0.07, 0.26, 0.18]} /><meshStandardMaterial color="#ccd9d8" roughness={0.6} /></mesh>
      <mesh position={[-3.875, 1.98, 2.6]}><boxGeometry args={[0.015, 0.07, 0.07]} /><meshStandardMaterial color="#68d3b3" emissive="#3ea783" emissiveIntensity={0.6} /></mesh>

      {/* Compact wall-mounted precision cooling unit with intake grille. */}
      <group position={[-2.45, 1.95, 3.39]} rotation={[0, Math.PI, 0]}>
        <mesh>
          <boxGeometry args={[1.15, 0.78, 0.18]} />
          <meshStandardMaterial color="#c5d1d2" metalness={0.34} roughness={0.38} />
        </mesh>
        <mesh position={[0, 0.22, 0.105]}>
          <boxGeometry args={[0.9, 0.22, 0.035]} />
          <meshStandardMaterial color="#82949a" metalness={0.34} roughness={0.48} />
        </mesh>
        {[-0.31, -0.23, -0.15, -0.07, 0.01, 0.09, 0.17, 0.25, 0.33].map((x) => (
          <mesh key={`grille-${x}`} position={[x, 0.22, 0.128]}>
            <boxGeometry args={[0.018, 0.17, 0.012]} />
            <meshStandardMaterial color="#dce6e5" metalness={0.54} roughness={0.32} />
          </mesh>
        ))}
        <mesh position={[0.43, -0.25, 0.105]}>
          <boxGeometry args={[0.08, 0.035, 0.015]} />
          <meshStandardMaterial color="#6bd5dd" emissive="#189eaa" emissiveIntensity={0.65} toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.43, -0.01]}>
          <boxGeometry args={[0.11, 0.16, 0.1]} />
          <meshStandardMaterial color="#657980" metalness={0.66} roughness={0.34} />
        </mesh>
      </group>

      {/* Runtime-connected room health board faces into the aisle. */}
      <WallDisplay position={[1.72, 1.78, 3.42]} rotationY={Math.PI} width={1.75} height={1.0} variant="monitoring" data={data} />

      {/* Small conduit run links the wall cooling and status display to the overhead tray. */}
      <mesh position={[0.72, 2.47, 3.38]}>
        <boxGeometry args={[2.8, 0.055, 0.07]} />
        <meshStandardMaterial color="#68777c" metalness={0.66} roughness={0.35} />
      </mesh>
    </group>
  );
}
