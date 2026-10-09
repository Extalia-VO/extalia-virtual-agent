import { ArmChair, Sofa } from "./Sofa";
import { AreaRug } from "../props/OfficeDecor";
import { SmartScreen } from "../screens/SmartScreen";
import { StaticScreenLight } from "../screens/StaticScreenLight";
import type { SmartScreenData } from "../../screenData";

const ENTERTAINMENT_TV_DATA: SmartScreenData = {
  title: "EXTALIA LOUNGE",
  subtitle: "Now playing",
  status: "LIVE"
};

const dark = "#16212d";
const neon = "#43d9da";
const brass = "#c79a67";

function ArcadeCabinet({ position, color }: { position: [number, number, number]; color: string }) {
  return <group position={position} rotation={[0, -Math.PI / 2, 0]}>
    <mesh castShadow position={[0, 0.9, 0]}><boxGeometry args={[0.78, 1.8, 0.66]} /><meshStandardMaterial color={dark} /></mesh>
    <mesh position={[0, 1.48, 0.345]}><boxGeometry args={[0.66, 0.4, 0.025]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} /></mesh>
    <mesh position={[0, 1.08, 0.348]}><boxGeometry args={[0.61, 0.43, 0.026]} /><meshStandardMaterial color="#123c60" emissive="#116fa7" emissiveIntensity={0.55} /></mesh>
    {/* Game screen and lit marquee keep glowing into the room when the lamps are off. */}
    <StaticScreenLight position={[0, 1.08, 0.348]} width={0.61} height={0.43} color="#116fa7" luminance={0.08} />
    <StaticScreenLight position={[0, 1.48, 0.345]} width={0.66} height={0.4} color={color} luminance={0.2} />
    <mesh position={[0, 0.7, 0.43]} rotation={[-0.25, 0, 0]}><boxGeometry args={[0.69, 0.11, 0.28]} /><meshStandardMaterial color="#293344" /></mesh>
    {[-0.17, 0.17].map((x) => <mesh key={x} position={[x, 0.81, 0.48]}><sphereGeometry args={[0.045, 8, 8]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} /></mesh>)}
    <mesh position={[0, 0.08, 0.35]}><boxGeometry args={[0.7, 0.06, 0.025]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} /></mesh>
  </group>;
}

function Foosball() {
  return <group position={[2.05, 0, 0.8]}>
    {[-0.7, 0.7].map((x) => [-0.45, 0.45].map((z) => <mesh key={`${x}-${z}`} castShadow position={[x, 0.39, z]}><boxGeometry args={[0.1, 0.78, 0.1]} /><meshStandardMaterial color={dark} /></mesh>))}
    <mesh castShadow position={[0, 0.83, 0]}><boxGeometry args={[1.64, 0.19, 1.14]} /><meshStandardMaterial color="#44312b" /></mesh>
    <mesh position={[0, 0.94, 0]}><boxGeometry args={[1.44, 0.022, 0.94]} /><meshStandardMaterial color="#2d805b" /></mesh>
    {[-0.34, 0, 0.34].map((x, row) => <group key={x}>
      <mesh position={[x, 1.04, 0]}><cylinderGeometry args={[0.016, 0.016, 1.46, 8]} /><meshStandardMaterial color="#aab9c4" metalness={0.8} roughness={0.3} /></mesh>
      {[-0.28, 0.28].map((z) => <mesh key={z} position={[x, 0.99, z]}><boxGeometry args={[0.08, 0.13, 0.09]} /><meshStandardMaterial color={row === 1 ? neon : "#e49963"} /></mesh>)}
    </group>)}
  </group>;
}

function MiniBar() {
  return <group position={[-3.75, 0, -0.65]}>
    <mesh castShadow position={[0, 0.57, 0]}><boxGeometry args={[0.72, 1.13, 0.86]} /><meshStandardMaterial color={dark} metalness={0.3} /></mesh>
    <mesh position={[0.37, 0.59, 0]}><boxGeometry args={[0.025, 0.94, 0.69]} /><meshPhysicalMaterial color="#a3e6ee" transparent opacity={0.35} metalness={0.15} roughness={0.16} /></mesh>
    {[0.34, 0.72].map((y) => <group key={y}>
      <mesh position={[0.12, y, 0]}><boxGeometry args={[0.46, 0.025, 0.69]} /><meshStandardMaterial color="#5c6972" /></mesh>
      {[-0.22, 0, 0.22].map((z) => <mesh key={z} position={[0.13, y + 0.11, z]}><cylinderGeometry args={[0.065, 0.065, 0.2, 10]} /><meshStandardMaterial color={y < 0.5 ? "#eb875c" : neon} metalness={0.5} /></mesh>)}
    </group>)}
    <mesh position={[0.38, 0.61, 0.31]}><boxGeometry args={[0.035, 0.32, 0.025]} /><meshStandardMaterial color={brass} /></mesh>
    <mesh castShadow position={[0, 1.23, -0.02]}><boxGeometry args={[0.8, 0.11, 0.95]} /><meshStandardMaterial color="#735440" /></mesh>
    {[-0.25, 0, 0.25].map((z) => <mesh key={z} position={[0.1, 1.37, z]}><boxGeometry args={[0.24, 0.17, 0.15]} /><meshStandardMaterial color={z === 0 ? "#eb875c" : "#d8ba76"} /></mesh>)}
  </group>;
}

/** Coordinates are room-local; north is -Z and the south exterior is glazing. */
export function EntertainmentSuite() {
  return <group>
    {/* Screen and console mount to the solid north wall, away from the central entry. */}
    <mesh position={[-2.45, 1.61, -3.37]}><boxGeometry args={[3.1, 1.75, 0.08]} /><meshStandardMaterial color="#0a101b" metalness={0.5} roughness={0.25} /></mesh>
    {/* V2: looping animated media feed (canvas texture, throttled redraw in SmartScreen). */}
    <SmartScreen
      data={ENTERTAINMENT_TV_DATA}
      position={[-2.45, 1.61, -3.32]}
      width={2.95}
      height={1.59}
      bezel={0.02}
      depth={0.02}
      variant="media"
    />
    <mesh position={[-2.45, 1.48, -3.29]}><boxGeometry args={[2.5, 0.08, 0.012]} /><meshStandardMaterial color={neon} emissive={neon} emissiveIntensity={1.1} /></mesh>
    <mesh position={[-2.45, 0.94, -3.26]}><boxGeometry args={[1.63, 0.08, 0.12]} /><meshStandardMaterial color="#212731" /></mesh>
    <mesh castShadow position={[-2.45, 0.39, -3.09]}><boxGeometry args={[3.1, 0.72, 0.64]} /><meshStandardMaterial color="#39323a" /></mesh>
    {[-3.4, -2.45, -1.5].map((x) => <mesh key={x} position={[x, 0.4, -2.76]}><boxGeometry args={[0.018, 0.55, 0.015]} /><meshStandardMaterial color={brass} /></mesh>)}
    <mesh position={[-1.55, 0.84, -3.08]}><boxGeometry args={[0.15, 0.42, 0.32]} /><meshStandardMaterial color="#e4e8ee" metalness={0.3} /></mesh>
    <mesh position={[-3.1, 0.78, -3.05]}><boxGeometry args={[0.35, 0.16, 0.3]} /><meshStandardMaterial color="#11151b" /></mesh>
    <mesh position={[-2.45, 0.08, -2.79]}><boxGeometry args={[3.12, 0.045, 0.04]} /><meshStandardMaterial color={neon} emissive={neon} emissiveIntensity={1.1} /></mesh>

    <AreaRug position={[-1.65, 0.105, 0.65]} width={4.3} depth={3.2} color="#505165" borderColor="#86798a" />
    <Sofa position={[-1.85, 0, 1.9]} rotationY={Math.PI} color="#a08d9d" />
    <ArmChair position={[0.18, 0, 2.15]} rotationY={Math.PI} color="#b48d72" />
    <group position={[0.75, 0, -0.95]}>
      <mesh castShadow position={[-1.75, 0.41, 0.25]}><cylinderGeometry args={[0.56, 0.61, 0.12, 24]} /><meshStandardMaterial color="#a77f65" /></mesh>
      <mesh castShadow position={[-1.75, 0.21, 0.25]}><cylinderGeometry args={[0.23, 0.25, 0.35, 16]} /><meshStandardMaterial color={dark} /></mesh>
      <mesh position={[-1.92, 0.51, 0.26]}><sphereGeometry args={[0.13, 12, 8]} /><meshStandardMaterial color="#dfaa62" /></mesh>
      {[-1.45, -1.25].map((x) => <mesh key={x} position={[x, 0.5, 0.13]}><boxGeometry args={[0.15, 0.055, 0.09]} /><meshStandardMaterial color="#222936" /></mesh>)}
    </group>

    <MiniBar />
    <group position={[0.7, 0, 0]}><Foosball /></group>
    <ArcadeCabinet position={[3.65, 0, -1.8]} color={neon} />
    <ArcadeCabinet position={[3.65, 0, -0.9]} color="#f183bc" />
    {/* Low-intensity accent glow and recessed-looking spots; no opaque ceiling over cutaway. */}
    {[-2.8, 0, 2.8].map((x) => <mesh key={x} position={[x, 2.58, 0.35]}><cylinderGeometry args={[0.1, 0.1, 0.035, 12]} /><meshStandardMaterial color="#f4d7aa" emissive="#f4c38a" emissiveIntensity={0.7} /></mesh>)}
  </group>;
}
