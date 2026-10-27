import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, SRGBColorSpace, type Group, type Mesh, type MeshBasicMaterial } from "three";
import { hospitalityState, type EntertainmentSession } from "../../../movement/hospitality";
import { useSolarEnvironment } from "../../../Environment";
import { InteriorPart } from "../../InteriorPart";
import { ArmChair, Sofa } from "./Sofa";
import { AreaRug } from "../props/OfficeDecor";
import { SmartScreen } from "../screens/SmartScreen";
import { StaticScreenLight } from "../screens/StaticScreenLight";
import type { SmartScreenData } from "../../screenData";
import { ENTERTAINMENT_LAYOUT } from "../../entertainmentBlueprint";

const ENTERTAINMENT_TV_DATA: SmartScreenData = {
  title: "EXTALIA LOUNGE",
  subtitle: "Now playing",
  status: "LIVE"
};

const dark = "#16212d";
const neon = "#43d9da";
const brass = "#c79a67";

function ArcadeCabinet({ position, color, rotationY = -Math.PI / 2 }: { position: [number, number, number]; color: string; rotationY?: number }) {
  return <group position={position} rotation={[0, rotationY, 0]}>
    <InteriorPart model="arcade-shell">
    <mesh castShadow position={[0, 0.9, 0]}><boxGeometry args={[0.78, 1.8, 0.66]} /><meshStandardMaterial color={dark} /></mesh>
    <mesh position={[0, 0.7, 0.43]} rotation={[-0.25, 0, 0]}><boxGeometry args={[0.69, 0.11, 0.28]} /><meshStandardMaterial color="#293344" /></mesh>
    {[-0.17, 0.17].map((x) => <mesh key={x} position={[x, 0.81, 0.48]}><sphereGeometry args={[0.045, 8, 8]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} /></mesh>)}
    <mesh position={[0, 0.08, 0.35]}><boxGeometry args={[0.7, 0.06, 0.025]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} /></mesh>
    </InteriorPart>
    <mesh position={[0, 1.48, 0.345]}><boxGeometry args={[0.66, 0.4, 0.025]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} /></mesh>
    <mesh position={[0, 1.08, 0.348]}><boxGeometry args={[0.61, 0.43, 0.026]} /><meshStandardMaterial color="#123c60" emissive="#116fa7" emissiveIntensity={0.55} /></mesh>
    {/* Game screen and lit marquee keep glowing into the room when the lamps are off. */}
    <StaticScreenLight position={[0, 1.08, 0.348]} width={0.61} height={0.43} color="#116fa7" luminance={0.08} />
    <StaticScreenLight position={[0, 1.48, 0.345]} width={0.66} height={0.4} color={color} luminance={0.2} />
  </group>;
}

function Foosball({ position }: { position: [number, number, number] }) {
  return <group position={position}><InteriorPart model="foosball-table">
    {[-0.7, 0.7].map((x) => [-0.45, 0.45].map((z) => <mesh key={`${x}-${z}`} castShadow position={[x, 0.39, z]}><boxGeometry args={[0.1, 0.78, 0.1]} /><meshStandardMaterial color={dark} /></mesh>))}
    <mesh castShadow position={[0, 0.83, 0]}><boxGeometry args={[1.64, 0.19, 1.14]} /><meshStandardMaterial color="#44312b" /></mesh>
    <mesh position={[0, 0.94, 0]}><boxGeometry args={[1.44, 0.022, 0.94]} /><meshStandardMaterial color="#2d805b" /></mesh>
    {[-0.34, 0, 0.34].map((x, row) => <group key={x}>
      <mesh position={[x, 1.04, 0]}><cylinderGeometry args={[0.016, 0.016, 1.46, 8]} /><meshStandardMaterial color="#aab9c4" metalness={0.8} roughness={0.3} /></mesh>
      {[-0.28, 0.28].map((z) => <mesh key={z} position={[x, 0.99, z]}><boxGeometry args={[0.08, 0.13, 0.09]} /><meshStandardMaterial color={row === 1 ? neon : "#e49963"} /></mesh>)}
    </group>)}
  </InteriorPart></group>;
}

function MiniBar({ position }: { position: [number, number, number] }) {
  return <group position={position}><InteriorPart model="minibar">
    <mesh castShadow position={[0, 0.57, 0]}><boxGeometry args={[0.72, 1.13, 0.86]} /><meshStandardMaterial color={dark} metalness={0.3} /></mesh>
    <mesh position={[0.37, 0.59, 0]}><boxGeometry args={[0.025, 0.94, 0.69]} /><meshPhysicalMaterial color="#a3e6ee" transparent opacity={0.35} metalness={0.15} roughness={0.16} /></mesh>
    {[0.34, 0.72].map((y) => <group key={y}>
      <mesh position={[0.12, y, 0]}><boxGeometry args={[0.46, 0.025, 0.69]} /><meshStandardMaterial color="#5c6972" /></mesh>
      {[-0.22, 0, 0.22].map((z) => <mesh key={z} position={[0.13, y + 0.11, z]}><cylinderGeometry args={[0.065, 0.065, 0.2, 10]} /><meshStandardMaterial color={y < 0.5 ? "#eb875c" : neon} metalness={0.5} /></mesh>)}
    </group>)}
    <mesh position={[0.38, 0.61, 0.31]}><boxGeometry args={[0.035, 0.32, 0.025]} /><meshStandardMaterial color={brass} /></mesh>
    <mesh castShadow position={[0, 1.23, -0.02]}><boxGeometry args={[0.8, 0.11, 0.95]} /><meshStandardMaterial color="#735440" /></mesh>
    {[-0.25, 0, 0.25].map((z) => <mesh key={z} position={[0.1, 1.37, z]}><boxGeometry args={[0.24, 0.17, 0.15]} /><meshStandardMaterial color={z === 0 ? "#eb875c" : "#d8ba76"} /></mesh>)}
  </InteriorPart></group>;
}

/** Coordinates are room-local; north is -Z and the south exterior is glazing. */
export function EntertainmentSuite() {
  const L = ENTERTAINMENT_LAYOUT;
  const tvX = L.tvX, wall = L.wallZ;
  return <group>
    {/* TV lounge (west): screen and console mount to the solid north wall, west of the central entry. */}
    <InteriorPart model="tv-housing" position={[tvX, 1.61, wall]}>
    <mesh><boxGeometry args={[3.1, 1.75, 0.08]} /><meshStandardMaterial color="#0a101b" metalness={0.5} roughness={0.25} /></mesh>
    </InteriorPart>
    {/* V2: looping animated media feed (canvas texture, throttled redraw in SmartScreen). */}
    <SmartScreen
      data={ENTERTAINMENT_TV_DATA}
      position={[tvX, 1.61, wall + 0.05]}
      width={2.95}
      height={1.59}
      bezel={0.02}
      depth={0.02}
      variant="media"
      device="tv"
    />
    <ConsoleMatchScreen position={[tvX, 1.61, wall + 0.075]} />
    <mesh position={[tvX, 0.94, wall + 0.11]}><boxGeometry args={[1.63, 0.08, 0.12]} /><meshStandardMaterial color="#212731" /></mesh>
    <InteriorPart model="tv-console" position={[tvX, 0, wall + 0.28]}>
    <mesh castShadow position={[0, 0.39, 0]}><boxGeometry args={[3.1, 0.72, 0.64]} /><meshStandardMaterial color="#39323a" /></mesh>
    {[-0.95, 0, 0.95].map((x) => <mesh key={x} position={[x, 0.4, 0.33]}><boxGeometry args={[0.018, 0.55, 0.015]} /><meshStandardMaterial color={brass} /></mesh>)}
    </InteriorPart>
    <InteriorPart model="game-console" position={[tvX + 0.9, 0.75, wall + 0.29]}>
    <mesh position={[0, 0.21, 0]}><boxGeometry args={[0.15, 0.42, 0.32]} /><meshStandardMaterial color="#e4e8ee" metalness={0.3} /></mesh>
    </InteriorPart>
    <mesh position={[tvX - 0.65, 0.78, wall + 0.32]}><boxGeometry args={[0.35, 0.16, 0.3]} /><meshStandardMaterial color="#11151b" /></mesh>
    <mesh position={[tvX, 0.08, wall + 0.58]}><boxGeometry args={[3.12, 0.045, 0.04]} /><meshStandardMaterial color={neon} emissive={neon} emissiveIntensity={1.1} /></mesh>

    {/* Seating faces the screen: sofa and armchair in one row, coffee table between them and the TV. */}
    <AreaRug position={[-3.3, 0, -0.05]} width={4.8} depth={3.6} color="#505165" borderColor="#86798a" />
    <Sofa position={[L.sofa[0], 0, L.sofa[1]]} rotationY={Math.PI} color="#a08d9d" />
    <ArmChair position={[L.armchair[0], 0, L.armchair[1]]} rotationY={Math.PI} color="#b48d72" />
    <group position={[L.table[0], 0, L.table[1]]}>
      <InteriorPart model="lounge-round-table">
      <mesh castShadow position={[0, 0.41, 0]}><cylinderGeometry args={[0.56, 0.61, 0.12, 24]} /><meshStandardMaterial color="#a77f65" /></mesh>
      <mesh castShadow position={[0, 0.21, 0]}><cylinderGeometry args={[0.23, 0.25, 0.35, 16]} /><meshStandardMaterial color={dark} /></mesh>
      </InteriorPart>
      <mesh position={[-0.17, 0.51, 0.01]}><sphereGeometry args={[0.13, 12, 8]} /><meshStandardMaterial color="#dfaa62" /></mesh>
      <group position={[1.75, 0, -0.25]}><TabletopControllers /></group>
    </group>
    <MiniBar position={[L.miniBar[0], 0, L.miniBar[1]]} />

    {/* Game corner (east): arcades along the north wall facing the room, foosball in open floor. */}
    {L.arcades.map((x, index) => <ArcadeCabinet key={x} position={[x, 0, L.arcadeZ]} rotationY={0} color={index === 0 ? neon : "#f183bc"} />)}
    <Foosball position={[L.foosball[0], 0, L.foosball[1]]} />
    {/* Low-intensity accent glow and recessed-looking spots; no opaque ceiling over cutaway. */}
    {[-4, 0, 4].map((x) => <mesh key={x} position={[x, 2.58, 0.35]}><cylinderGeometry args={[0.1, 0.1, 0.035, 12]} /><meshStandardMaterial color="#f4d7aa" emissive="#f4c38a" emissiveIntensity={0.7} /></mesh>)}
  </group>;
}

/** Shared local match replaces media only once both console players have arrived. */
export function drawConsoleMatch(context: CanvasRenderingContext2D, match: EntertainmentSession, width: number, height: number): void {
  context.fillStyle = "#081d30"; context.fillRect(0, 0, width, height);
  context.strokeStyle = "#17616c"; context.lineWidth = 2;
  context.strokeRect(18, 18, width - 36, height - 36);
  context.setLineDash([8, 12]); context.beginPath(); context.moveTo(width / 2, 18); context.lineTo(width / 2, height - 18); context.stroke(); context.setLineDash([]);
  context.font = "bold 64px monospace"; context.textAlign = "center"; context.fillStyle = "#d4f6ef";
  context.fillText(String(match.score[0]), width * 0.35, 88); context.fillText(String(match.score[1]), width * 0.65, 88);
  context.fillStyle = "#43d9da"; context.fillRect(25, 25 + match.paddles[0] * (height - 112), 12, 62);
  context.fillStyle = "#f183bc"; context.fillRect(width - 37, 25 + match.paddles[1] * (height - 112), 12, 62);
  context.fillStyle = "#ffffff"; context.beginPath(); context.arc(44 + match.ball[0] * (width - 88), 30 + match.ball[1] * (height - 60), 9, 0, Math.PI * 2); context.fill();
}
type ConsoleMedia = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; texture: CanvasTexture };
function createConsoleMedia(): ConsoleMedia | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"); canvas.width = 768; canvas.height = 414;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
  return { canvas, context, texture };
}
function repaintConsoleMedia(media: ConsoleMedia, match: EntertainmentSession): void {
  drawConsoleMatch(media.context, match, media.canvas.width, media.canvas.height);
  media.texture.needsUpdate = true;
}
function ConsoleMatchScreen({ position }: { position: [number, number, number] }) {
  const screen = useRef<Mesh>(null);
  const nextDraw = useRef(0);
  const media = useRef<ConsoleMedia | null>(null);
  useEffect(() => {
    const resource = createConsoleMedia();
    media.current = resource;
    const material = screen.current?.material as MeshBasicMaterial | undefined;
    if (material && resource) { material.map = resource.texture; material.needsUpdate = true; }
    return () => {
      media.current = null;
      if (material) { material.map = null; material.needsUpdate = true; }
      resource?.texture.dispose();
    };
  }, []);
  useFrame(({ clock }) => {
    const match = hospitalityState.entertainment();
    const active = match !== null && match.startedAt !== null;
    const resource = media.current;
    if (screen.current) screen.current.visible = active && resource !== null;
    if (!active || !resource || clock.elapsedTime < nextDraw.current) return;
    nextDraw.current = clock.elapsedTime + 1 / 12;
    repaintConsoleMedia(resource, match);
  });
  return <mesh ref={screen} position={position} visible={false} userData={{ officeDynamic: true, officeCollision: false }}>
    <planeGeometry args={[2.95, 1.59]} /><meshBasicMaterial toneMapped={false} />
  </mesh>;
}

/** Each arrived player takes one controller; cancellation returns both to the table. */
export function syncTabletopControllers(root: Group, match: EntertainmentSession | null, reducedMotion: boolean): void {
  root.children.forEach((controller, index) => {
    const player = match?.players[index];
    controller.visible = reducedMotion || !match || !player || !match.arrived.has(player);
  });
}
function TabletopControllers() {
  const controllers = useRef<Group>(null);
  const { reducedMotion } = useSolarEnvironment();
  useFrame(() => { if (controllers.current) syncTabletopControllers(controllers.current, hospitalityState.entertainment(), reducedMotion); });
  return <group ref={controllers} userData={{ officeDynamic: true, officeCollision: false }}>
    {[-1.45, -1.25].map(x => <group key={x} position={[x, 0.51, 0.13]}><InteriorPart model="game-controller"><mesh><boxGeometry args={[0.16, 0.058, 0.108]} /><meshStandardMaterial color="#e4e8ee" /></mesh></InteriorPart></group>)}
  </group>;
}
