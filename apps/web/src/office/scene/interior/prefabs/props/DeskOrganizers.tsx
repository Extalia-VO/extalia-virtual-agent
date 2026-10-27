/**
 * Small furniture and personal items on a desktop: a mini drawer cabinet for
 * documents, stacked letter trays, a file holder with folders, books between
 * bookends, a plant, a photo, a notebook, a headphone stand, a pen cup and
 * sticky notes. Each item's origin rests on the desk; its front faces +Z (the
 * sitter). Low-poly and shadow-light so a floor of desks stays cheap.
 */
import type { ReactNode } from "react";
import type { DeskAccessoryKind, DeskLayout, DeskSlot } from "../../deskLayout";
import { WorkstationPart } from "../../WorkstationPart";
import { useSolarEnvironment } from "../../../Environment";

const PALETTES = [
  { body: "#d9d6cf", accent: "#5e8f8b", warm: "#c98a5b", paper: "#f3f0e8" },
  { body: "#3a4246", accent: "#c9a25d", warm: "#9c5d4c", paper: "#efece4" },
  { body: "#b9c4c4", accent: "#6f7fa6", warm: "#d1b27c", paper: "#f6f3ec" },
  { body: "#7a6250", accent: "#4d7a63", warm: "#c7764f", paper: "#f1ede3" },
] as const;
type Palette = typeof PALETTES[number];

function Box({ size, position = [0, 0, 0], color, rotation, roughness = 0.7, shadow = false }: {
  size: [number, number, number]; position?: [number, number, number]; color: string;
  rotation?: [number, number, number]; roughness?: number; shadow?: boolean;
}) {
  return <mesh castShadow={shadow} receiveShadow position={position} rotation={rotation}>
    <boxGeometry args={size} /><meshStandardMaterial color={color} roughness={roughness} />
  </mesh>;
}

/** Three-drawer document cabinet (A4 drawers) with pull handles and a sheet peeking out. */
function DrawerUnit({ p }: { p: Palette }) {
  const w = 0.22, h = 0.2, d = 0.3;
  return <group>
    <Box size={[w, h, d]} position={[0, h / 2, 0]} color={p.body} shadow />
    {[0, 1, 2].map(i => {
      const y = 0.035 + i * 0.062;
      return <group key={i}>
        <Box size={[w - 0.016, 0.054, 0.006]} position={[0, y, d / 2 + 0.002]} color={i === 1 ? p.accent : p.body} roughness={0.55} />
        <Box size={[0.06, 0.008, 0.012]} position={[0, y + 0.012, d / 2 + 0.008]} color="#8d969a" roughness={0.35} />
      </group>;
    })}
    <Box size={[0.19, 0.002, 0.1]} position={[0.01, 0.068, d / 2 - 0.02]} rotation={[0, 0.05, 0]} color={p.paper} />
  </group>;
}

/** Two stacked letter trays with paper. */
function LetterTray({ p }: { p: Palette }) {
  const w = 0.25, d = 0.32;
  return <group>
    {[0, 0.075].map((y, i) => <group key={y} position={[0, y, 0]}>
      <Box size={[w, 0.006, d]} position={[0, 0.003, 0]} color={p.body} />
      <Box size={[w, 0.04, 0.006]} position={[0, 0.02, -d / 2]} color={p.body} />
      {[-1, 1].map(side => <Box key={side} size={[0.006, 0.03, d]} position={[side * w / 2, 0.015, 0]} color={p.body} />)}
      <Box size={[0.21, 0.012 - i * 0.006, 0.297]} position={[0, 0.012, 0.005]} color={p.paper} roughness={0.9} />
    </group>)}
    {[-1, 1].flatMap(sx => [-1, 1].map(sz => <Box key={`${sx}${sz}`} size={[0.008, 0.075, 0.008]} position={[sx * (w / 2 - 0.01), 0.04, sz * (d / 2 - 0.02)]} color="#8d969a" />))}
  </group>;
}

/** Magazine file holder with three folders and a binder. */
function FileHolder({ p }: { p: Palette }) {
  const colors = [p.accent, p.warm, "#e2c86f", p.body];
  return <group>
    <Box size={[0.1, 0.12, 0.25]} position={[0, 0.06, 0]} color={p.body} shadow />
    <Box size={[0.1, 0.13, 0.12]} position={[0, 0.185, -0.065]} color={p.body} />
    {colors.map((color, i) => <Box key={i} size={[0.012 + (i === 3 ? 0.02 : 0), 0.25 - i * 0.012, 0.23]}
      position={[-0.036 + i * 0.022, 0.13 - i * 0.006, 0]} rotation={[0, 0, (i - 1.5) * 0.04]} color={color} roughness={0.8} />)}
  </group>;
}

/** Five books standing between two bookends. */
function Books({ p }: { p: Palette }) {
  const books = [[0.032, 0.21, p.accent], [0.026, 0.19, p.warm], [0.04, 0.23, "#3f4b55"], [0.022, 0.18, "#e2c86f"], [0.03, 0.2, p.body]] as const;
  let x = -0.075;
  return <group>
    {books.map(([t, h, color], i) => {
      const at = x + t / 2; x += t + 0.002;
      return <group key={i}>
        <Box size={[t, h, 0.15]} position={[at, h / 2, 0]} color={color} roughness={0.75} shadow />
        <Box size={[t * 0.6, 0.012, 0.002]} position={[at, h * 0.75, 0.076]} color={p.paper} />
      </group>;
    })}
    {[-0.083, x + 0.006].map((bx, i) => <group key={i} position={[bx, 0, 0]}>
      <Box size={[0.004, 0.12, 0.1]} position={[0, 0.06, 0]} color="#5c6468" roughness={0.35} />
      <Box size={[0.05, 0.003, 0.1]} position={[i === 0 ? 0.025 : -0.025, 0.0015, 0]} color="#5c6468" roughness={0.35} />
    </group>)}
  </group>;
}

/** Ceramic pot with a leafy plant. */
function DeskPlant({ p }: { p: Palette }) {
  const leaves = Array.from({ length: 7 }, (_, i) => i);
  return <group>
    <mesh castShadow receiveShadow position={[0, 0.045, 0]}>
      <cylinderGeometry args={[0.055, 0.042, 0.09, 14]} /><meshStandardMaterial color={p.warm} roughness={0.6} />
    </mesh>
    <mesh position={[0, 0.088, 0]}><cylinderGeometry args={[0.05, 0.05, 0.006, 14]} /><meshStandardMaterial color="#3b2e24" roughness={1} /></mesh>
    {leaves.map(i => {
      const angle = i * 2.4, tilt = 0.35 + (i % 3) * 0.18;
      return <mesh key={i} castShadow position={[Math.sin(angle) * 0.025, 0.14 + (i % 2) * 0.02, Math.cos(angle) * 0.025]}
        rotation={[Math.cos(angle) * tilt, angle, Math.sin(angle) * tilt]} scale={[0.028, 0.075, 0.009]}>
        <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={i % 2 ? "#4f7d4a" : "#61935a"} roughness={0.75} />
      </mesh>;
    })}
  </group>;
}

/** Framed photo on an easel back. */
function Photo({ p }: { p: Palette }) {
  return <group rotation={[0, 0, 0]}>
    <group position={[0, 0.07, 0]} rotation={[-0.2, 0, 0]}>
      <Box size={[0.13, 0.1, 0.012]} color={p.body} roughness={0.5} />
      <mesh position={[0, 0, 0.0065]}><planeGeometry args={[0.105, 0.075]} /><meshStandardMaterial color={p.accent} roughness={0.4} /></mesh>
      <mesh position={[-0.02, -0.01, 0.007]}><circleGeometry args={[0.018, 12]} /><meshStandardMaterial color={p.warm} roughness={0.5} /></mesh>
    </group>
    <Box size={[0.02, 0.09, 0.004]} position={[0, 0.045, -0.03]} rotation={[0.45, 0, 0]} color={p.body} />
  </group>;
}

/** Closed notebook with a pen across it. */
function Notebook({ p }: { p: Palette }) {
  return <group>
    <Box size={[0.15, 0.014, 0.21]} position={[0, 0.007, 0]} color={p.accent} roughness={0.85} />
    <Box size={[0.145, 0.012, 0.205]} position={[0.003, 0.007, 0]} color={p.paper} roughness={0.9} />
    <Box size={[0.012, 0.0145, 0.21]} position={[-0.07, 0.0072, 0]} color={p.accent} />
    <mesh position={[0.02, 0.018, 0.02]} rotation={[Math.PI / 2, 0, 0.5]}>
      <cylinderGeometry args={[0.004, 0.004, 0.14, 8]} /><meshStandardMaterial color="#2f3538" roughness={0.4} />
    </mesh>
  </group>;
}

/** Over-ear headphones hanging on a stand. */
function Headphones({ p }: { p: Palette }) {
  return <group>
    <mesh position={[0, 0.006, 0]}><cylinderGeometry args={[0.055, 0.06, 0.012, 16]} /><meshStandardMaterial color="#2c3134" roughness={0.4} /></mesh>
    <Box size={[0.014, 0.24, 0.014]} position={[0, 0.125, 0]} color="#2c3134" roughness={0.4} />
    <Box size={[0.06, 0.012, 0.03]} position={[0, 0.245, 0]} color="#2c3134" roughness={0.4} />
    <mesh castShadow position={[0, 0.2, 0]} rotation={[0, Math.PI / 2, 0]}>
      <torusGeometry args={[0.075, 0.009, 6, 18, Math.PI]} /><meshStandardMaterial color={p.body === "#3a4246" ? "#c9c3b8" : "#2b3033"} roughness={0.5} />
    </mesh>
    {[-1, 1].map(side => <mesh key={side} castShadow position={[0, 0.13, side * 0.075]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.04, 0.04, 0.028, 16]} /><meshStandardMaterial color="#2b3033" roughness={0.6} />
    </mesh>)}
  </group>;
}

/** Pen cup with three pens. */
function PenCup() {
  return <group>
    <mesh position={[0, 0.05, 0]}><cylinderGeometry args={[0.04, 0.036, 0.1, 16]} /><meshStandardMaterial color="#39464a" roughness={0.52} /></mesh>
    {([[-0.016, 0.125, -0.008, -0.08], [0.004, 0.14, 0.006, 0.06], [0.018, 0.12, -0.003, -0.1]] as const).map(([x, y, z, tilt], index) => (
      <mesh key={index} position={[x, y, z]} rotation={[0, 0, tilt]}>
        <cylinderGeometry args={[0.0038, 0.0038, 0.14, 8]} />
        <meshStandardMaterial color={["#be7556", "#527f82", "#d2af70"][index]} roughness={0.52} />
      </mesh>
    ))}
  </group>;
}

/** A pad of sticky notes with a loose note beside it. */
function StickyNotes() {
  return <group>
    <Box size={[0.076, 0.018, 0.076]} position={[0, 0.009, 0]} color="#efd36a" roughness={0.9} />
    <Box size={[0.076, 0.001, 0.076]} position={[0.07, 0.0005, 0.03]} rotation={[0, 0.4, 0]} color="#9fd3c7" roughness={0.9} />
  </group>;
}

function MiniShelf({ p }: { p: Palette }) {
  return <group>
    {[.008, .14, .28].map(y => <Box key={y} size={[.22,.016,.18]} position={[0,y,0]} color={p.warm} shadow />)}
    {[-.105,.105].map(x => <Box key={x} size={[.012,.28,.18]} position={[x,.14,0]} color={p.body} shadow />)}
    <group position={[0,.018,0]} scale={.55}><Books p={p} /></group>
  </group>;
}

function FlowerVase({ p }: { p: Palette }) {
  return <group>
    <mesh position={[0,.045,0]}><cylinderGeometry args={[.034,.045,.09,16]} /><meshStandardMaterial color={p.warm} roughness={.45} /></mesh>
    {[-1,0,1].map(i => <group key={i} position={[i*.02,.15+Math.abs(i)*.02,0]}>
      <mesh position={[0,-.04,0]}><cylinderGeometry args={[.002,.002,.12,6]} /><meshStandardMaterial color="#59805c" /></mesh>
      {Array.from({length:5},(_,k) => <mesh key={k} position={[Math.sin(k*1.257)*.016,0,Math.cos(k*1.257)*.016]} scale={[.013,.007,.017]}><sphereGeometry args={[1,8,6]} /><meshStandardMaterial color={i===0?'#d6a0ad':'#e8d6ae'} roughness={.8} /></mesh>)}
    </group>)}
  </group>;
}

function OrnamentLamp() {
  const { state } = useSolarEnvironment();
  return <group>
    <mesh position={[0,.009,0]}><cylinderGeometry args={[.055,.06,.018,16]} /><meshStandardMaterial color="#637174" roughness={.5} /></mesh>
    <mesh position={[0,.14,0]}><cylinderGeometry args={[.006,.006,.26,10]} /><meshStandardMaterial color="#b99d69" metalness={.6} roughness={.3} /></mesh>
    <mesh position={[0,.25,0]}><cylinderGeometry args={[.04,.06,.09,16]} /><meshStandardMaterial color="#e7d9be" emissive="#ffcc84" emissiveIntensity={state.factors.interiorLightFactor*2} roughness={.8} /></mesh>
  </group>;
}

function accessory(kind: DeskAccessoryKind, p: Palette): ReactNode {
  switch (kind) {
    case "drawer-unit": return <DrawerUnit p={p} />;
    case "letter-tray": return <LetterTray p={p} />;
    case "file-holder": return <FileHolder p={p} />;
    case "books": return <Books p={p} />;
    case "plant": return <DeskPlant p={p} />;
    case "photo": return <Photo p={p} />;
    case "notebook": return <Notebook p={p} />;
    case "headphones": return <Headphones p={p} />;
    case "pen-cup": return <PenCup />;
    case "sticky-notes": return <StickyNotes />;
    case "desk-shelf": return <MiniShelf p={p} />;
    case "flower-vase": return <FlowerVase p={p} />;
    case "ornament-lamp": return <OrnamentLamp />;
  }
}

/** The desk's own items in its slots (desk frame), resting on the desktop at `topY`. */
export function DeskAccessorySlots({ layout, slots, topY }: { layout: DeskLayout; slots: readonly DeskSlot[]; topY: number }) {
  const palette = PALETTES[Math.floor(layout.tint * PALETTES.length) % PALETTES.length]!;
  return <group>
    {layout.accessories.map((kind, index) => {
      const slot = slots[index];
      if (!kind || !slot) return null;
      return <group key={index} position={[slot.position[0], topY, slot.position[1]]} rotation={[0, slot.yaw, 0]}>
        <WorkstationPart asset={kind}>{accessory(kind, palette)}</WorkstationPart>
      </group>;
    })}
  </group>;
}

/** Height and tilt of the laptop stand: the deck rises toward the back so the screen sits nearer eye level. */
export const LAPTOP_STAND = Object.freeze({ front: 0.07, back: 0.13, depth: 0.24, width: 0.24 });

/**
 * An aluminium laptop stand; its child (the laptop) rests on the sloped top.
 * Origin on the desk at the stand's centre; the low edge faces +Z.
 */
export function LaptopStand({ children }: { children?: ReactNode }) {
  const { front, back, depth, width } = LAPTOP_STAND;
  const tilt = Math.atan2(back - front, depth);
  const mid = (front + back) / 2;
  return <group>
    {[-1, 1].map(side => <group key={side} position={[side * (width / 2 - 0.01), 0, 0]}>
      <Box size={[0.012, 0.008, depth]} position={[0, 0.004, 0]} color="#a9b0b3" roughness={0.3} />
      <Box size={[0.012, back, 0.012]} position={[0, back / 2, -depth / 2 + 0.01]} rotation={[0.12, 0, 0]} color="#a9b0b3" roughness={0.3} />
      <Box size={[0.012, front, 0.012]} position={[0, front / 2, depth / 2 - 0.02]} color="#a9b0b3" roughness={0.3} />
    </group>)}
    <group position={[0, mid, 0]} rotation={[tilt, 0, 0]}>
      <Box size={[width, 0.006, depth]} color="#b9c0c3" roughness={0.3} shadow />
      <Box size={[width, 0.014, 0.008]} position={[0, 0.008, depth / 2 - 0.004]} color="#b9c0c3" roughness={0.3} />
      <group position={[0, 0.003, 0]}>{children}</group>
    </group>
  </group>;
}
