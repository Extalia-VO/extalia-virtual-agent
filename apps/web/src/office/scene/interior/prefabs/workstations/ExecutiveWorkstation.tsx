import { useMemo } from "react";
import { Shape } from "three";
import type { SmartScreenData } from "../../screenData";
import { ExecutiveChair, GuestChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Keyboard } from "../props/Keyboard";
import { MouseAndPad } from "../props/DeskAccessories";
import { Plant } from "../props/Plant";
import { EXECUTIVE_OFFICE_BLUEPRINT } from "../../spatialBlueprints";

export interface ExecutiveSeatPose {
  position: [number, number, number];
  rotationY: number;
}

/**
 * Local convention:
 *
 *   -Z  = CEO / rear cabinet side
 *   +Z  = guest / room-entry side
 *
 * The CEO sits behind the main desk and faces +Z.
 */
export const EXECUTIVE_LEADER_SEAT: ExecutiveSeatPose = {
  position: [...EXECUTIVE_OFFICE_BLUEPRINT.leaderSeat.position],
  rotationY: EXECUTIVE_OFFICE_BLUEPRINT.leaderSeat.rotationY
};

function executiveTopShape() {
  const shape = new Shape();
  // Continuous L with a rounded inside corner beside the CEO chair.
  shape.moveTo(-2.11, 0.63);
  shape.lineTo(2.15, 0.63);
  shape.quadraticCurveTo(2.3, 0.63, 2.3, 0.48);
  shape.lineTo(2.3, -0.43);
  shape.quadraticCurveTo(2.3, -0.57, 2.16, -0.57);
  shape.lineTo(-1.0, -0.57);
  shape.quadraticCurveTo(-1.19, -0.57, -1.19, -0.78);
  shape.lineTo(-1.19, -2.32);
  shape.quadraticCurveTo(-1.19, -2.47, -1.34, -2.47);
  shape.lineTo(-2.09, -2.47);
  shape.quadraticCurveTo(-2.24, -2.47, -2.24, -2.32);
  shape.lineTo(-2.24, 0.5);
  shape.quadraticCurveTo(-2.24, 0.63, -2.11, 0.63);
  return shape;
}

/** Ultra-modern bespoke executive millwork & display cabinet with integrated LED illumination. */
function ExecutiveLuxuryCabinet({
  position = [0, 0, 0],
  width = 5.2
}: {
  position?: [number, number, number];
  width?: number;
}) {
  const halfW = width / 2;

  return (
    <group position={position}>
      {/* 1. Sasis Belakang & Panel Dinding Akustik Kayu Walnut Gelap */}
      <mesh position={[0, 1.32, -0.22]} castShadow receiveShadow>
        <boxGeometry args={[width, 2.64, 0.06]} />
        <meshStandardMaterial color="#221a14" roughness={0.45} />
      </mesh>

      {/* Fluted vertical wood slats on backplate for rich texture */}
      {Array.from({ length: 27 }, (_, i) => {
        const x = -halfW + 0.15 + i * 0.188;
        return (
          <mesh key={`back-slat-${i}`} position={[x, 1.32, -0.185]}>
            <boxGeometry args={[0.045, 2.58, 0.015]} />
            <meshStandardMaterial color="#1a1410" roughness={0.5} />
          </mesh>
        );
      })}

      {/* Frame Luar & Pilaster Vertikal dengan Aksen Kuningan Champagne */}
      {[-halfW, halfW].map((x, i) => (
        <mesh key={`outer-stiles-${i}`} position={[x, 1.32, -0.05]} castShadow>
          <boxGeometry args={[0.065, 2.64, 0.42]} />
          <meshStandardMaterial color="#2a2018" roughness={0.35} />
        </mesh>
      ))}
      {[-halfW, halfW].map((x, i) => (
        <mesh key={`brass-stiles-${i}`} position={[x + (i === 0 ? 0.034 : -0.034), 1.32, 0.16]}>
          <boxGeometry args={[0.012, 2.64, 0.02]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
        </mesh>
      ))}

      {/* Pilaster Tengah Interior Pembagi Kompartemen */}
      {[-0.85, 0.85].map((x, i) => (
        <group key={`divider-${i}`} position={[x, 1.32, -0.05]}>
          <mesh castShadow>
            <boxGeometry args={[0.045, 2.64, 0.38]} />
            <meshStandardMaterial color="#241c16" roughness={0.38} />
          </mesh>
          <mesh position={[0, 0, 0.192]}>
            <boxGeometry args={[0.008, 2.64, 0.012]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
          </mesh>
        </group>
      ))}

      {/* Top Cap Pelindung Atas */}
      <mesh position={[0, 2.62, -0.05]} castShadow>
        <boxGeometry args={[width + 0.04, 0.06, 0.44]} />
        <meshStandardMaterial color="#2a2018" roughness={0.35} />
      </mesh>
      <mesh position={[0, 2.62, 0.17]}>
        <boxGeometry args={[width + 0.05, 0.015, 0.015]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* 2. Bagian Bawah: Floating Credenza Storage (Y: 0 s/d 0.76) */}
      {/* Plinth kaki gantung dengan celah LED lantai */}
      <mesh position={[0, 0.04, -0.08]}>
        <boxGeometry args={[width - 0.12, 0.08, 0.32]} />
        <meshStandardMaterial color="#140f0c" roughness={0.8} />
      </mesh>
      {/* Pendar LED strip lantai di bawah lemari */}
      <mesh position={[0, 0.02, 0.06]}>
        <boxGeometry args={[width - 0.2, 0.012, 0.02]} />
        <meshStandardMaterial color="#ffffff" emissive="#fbbf24" emissiveIntensity={0.8} toneMapped={false} />
      </mesh>

      {/* Bodi credenza lemari bawah tertutup dengan pintu fluted */}
      <mesh position={[0, 0.42, -0.02]} castShadow>
        <boxGeometry args={[width - 0.04, 0.68, 0.45]} />
        <meshStandardMaterial color="#281f19" roughness={0.4} />
      </mesh>
      {/* Top Counter Marmer Travertine / Calacatta pada credenza bawah */}
      <mesh position={[0, 0.77, -0.01]} castShadow receiveShadow>
        <boxGeometry args={[width + 0.02, 0.035, 0.47]} />
        <meshStandardMaterial color="#dfd8cb" roughness={0.25} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.77, 0.228]}>
        <boxGeometry args={[width + 0.03, 0.008, 0.01]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* Pintu-pintu kabinet bawah dengan handle minimalis kuningan */}
      {[-1.85, -1.15, -0.45, 0.45, 1.15, 1.85].map((x, i) => (
        <group key={`door-${i}`} position={[x, 0.42, 0.21]}>
          <mesh castShadow>
            <boxGeometry args={[0.66, 0.64, 0.02]} />
            <meshStandardMaterial color="#2d231c" roughness={0.42} />
          </mesh>
          {/* Vertical brass handle pull */}
          <mesh position={[i % 2 === 0 ? 0.28 : -0.28, 0.12, 0.018]}>
            <boxGeometry args={[0.012, 0.18, 0.016]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
          </mesh>
        </group>
      ))}

      {/* 3. Rak-Rak Terbuka Atas dengan Lampu LED Tersembunyi (Y = 1.36, 1.95) */}
      {[1.36, 1.95].map((y, levelIdx) => (
        <group key={`shelf-tier-${levelIdx}`} position={[0, y, -0.04]}>
          {/* Ambalan kayu walnut */}
          <mesh castShadow receiveShadow>
            <boxGeometry args={[width - 0.08, 0.045, 0.38]} />
            <meshStandardMaterial color="#2f241d" roughness={0.38} />
          </mesh>
          {/* Lis depan kuningan mewah */}
          <mesh position={[0, 0, 0.192]}>
            <boxGeometry args={[width - 0.08, 0.016, 0.01]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
          </mesh>
          {/* Saluran lampu LED terintegrasi di bawah ambalan */}
          <mesh position={[0, -0.024, 0.05]}>
            <boxGeometry args={[width - 0.2, 0.008, 0.03]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#fff2d6"
              emissiveIntensity={1.4}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Sumber Cahaya PointLight Lemari Memberikan Pendar Hangat Lembut */}

      {/* 4. Center Feature Alcove: Backlit Travertine & Bronze Sculpture */}
      {/* Panel Marmer Belakang di Ceruk Tengah */}
      <mesh position={[0, 1.66, -0.19]}>
        <boxGeometry args={[1.62, 1.74, 0.015]} />
        <meshStandardMaterial color="#ded7cd" roughness={0.28} metalness={0.08} />
      </mesh>
      {/* Pedestal Hitam Marmer untuk Patung Seni */}
      <mesh position={[0, 0.86, 0.0]} castShadow>
        <cylinderGeometry args={[0.22, 0.24, 0.14, 24]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.2} metalness={0.3} />
      </mesh>
      {/* Patung Seni Abstrak Ribbon Modern Berbahan Perunggu Kuningan */}
      <group position={[0, 1.15, 0.0]} rotation={[0.2, 0.5, 0.1]}>
        <mesh castShadow>
          <torusKnotGeometry args={[0.18, 0.045, 64, 16, 2, 3]} />
          <meshStandardMaterial color="#c59b4c" metalness={0.9} roughness={0.2} />
        </mesh>
      </group>
      {/* Spotlight Aksen Khusus Patung */}

      {/* 5. Kompartemen Kiri: Smoked Glass Display & Curated Architecture Monographs */}
      {/* Pintu Kaca Tempered Bronze Gelap di Kompartemen Kiri Atas */}
      <mesh position={[-1.75, 1.95, 0.15]}>
        <boxGeometry args={[1.65, 0.55, 0.01]} />
        <meshStandardMaterial
          color="#382d24"
          transparent
          opacity={0.35}
          roughness={0.1}
          metalness={0.4}
        />
      </mesh>
      {/* Frame Kaca Kuningan */}
      <mesh position={[-1.75, 1.95, 0.155]}>
        <boxGeometry args={[1.66, 0.56, 0.006]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.8} roughness={0.3} wireframe />
      </mesh>

      {/* Koleksi Buku & Monograf Desain Premium (Rak Y = 0.79 s/d 1.34) */}
      <group position={[-1.9, 0.79, 0.0]}>
        {[
          { color: "#1e293b", w: 0.05, h: 0.38, d: 0.26 },
          { color: "#854d0e", w: 0.04, h: 0.35, d: 0.25 },
          { color: "#ded6c7", w: 0.06, h: 0.40, d: 0.27 },
          { color: "#3f3f46", w: 0.045, h: 0.36, d: 0.25 },
          { color: "#991b1b", w: 0.055, h: 0.39, d: 0.26 },
          { color: "#164e63", w: 0.04, h: 0.34, d: 0.24 },
          { color: "#365314", w: 0.05, h: 0.37, d: 0.26 }
        ].map((book, i) => (
          <group key={`book-a-${i}`} position={[i * 0.06 - 0.2, book.h / 2, 0]}>
            <mesh castShadow>
              <boxGeometry args={[book.w, book.h, book.d]} />
              <meshStandardMaterial color={book.color} roughness={0.65} />
            </mesh>
            {/* Gold foil spine detail */}
            <mesh position={[0, 0, book.d / 2 + 0.001]}>
              <boxGeometry args={[book.w * 0.7, 0.02, 0.002]} />
              <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
            </mesh>
          </group>
        ))}
      </group>

      {/* Vas Keramik Stoneware Minimalis di Rak Tengah Kiri (Y = 1.38) */}
      <group position={[-1.25, 1.38, 0.0]}>
        <mesh castShadow position={[0, 0.16, 0]}>
          <cylinderGeometry args={[0.07, 0.12, 0.32, 16]} />
          <meshStandardMaterial color="#e2ded4" roughness={0.4} />
        </mesh>
        <mesh castShadow position={[0.26, 0.11, 0.04]}>
          <cylinderGeometry args={[0.08, 0.06, 0.22, 16]} />
          <meshStandardMaterial color="#3b3734" roughness={0.6} />
        </mesh>
      </group>

      {/* 6. Kompartemen Kanan: Crystal Decanter Bar Set & Executive Trophies */}
      {/* Set Decanter Wiski Kristal & Gelas di Rak Bawah Kanan (Y = 0.79) */}
      <group position={[1.45, 0.79, 0.02]}>
        {/* Nampan Marmer Hitam Lis Kuningan */}
        <mesh position={[0, 0.015, 0]} castShadow>
          <boxGeometry args={[0.55, 0.025, 0.32]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.25} />
        </mesh>
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[0.56, 0.01, 0.33]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
        </mesh>
        {/* Decanter Kristal Berisi Amber Liquid */}
        <mesh position={[-0.12, 0.16, 0]} castShadow>
          <boxGeometry args={[0.12, 0.26, 0.12]} />
          <meshStandardMaterial color="#fef3c7" transparent opacity={0.65} roughness={0.05} metalness={0.2} />
        </mesh>
        <mesh position={[-0.12, 0.31, 0]}>
          <sphereGeometry args={[0.04, 16, 12]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
        </mesh>
        {/* Dua Gelas Tumbler Kristal */}
        <mesh position={[0.12, 0.08, -0.06]} castShadow>
          <cylinderGeometry args={[0.042, 0.038, 0.09, 14]} />
          <meshStandardMaterial color="#ffffff" transparent opacity={0.55} roughness={0.08} />
        </mesh>
        <mesh position={[0.12, 0.08, 0.06]} castShadow>
          <cylinderGeometry args={[0.042, 0.038, 0.09, 14]} />
          <meshStandardMaterial color="#ffffff" transparent opacity={0.55} roughness={0.08} />
        </mesh>
      </group>

      {/* Piala / Penghargaan Eksekutif & Sertifikat Berbingkai Kuningan di Rak Kanan (Y = 1.38) */}
      <group position={[1.75, 1.38, 0.0]}>
        {/* Trophy kristal piramida */}
        <mesh position={[-0.22, 0.14, 0]} castShadow>
          <coneGeometry args={[0.08, 0.28, 4]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
        </mesh>
        {/* Trophy pedestal */}
        <mesh position={[-0.22, 0.02, 0]}>
          <boxGeometry args={[0.12, 0.04, 0.12]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.3} />
        </mesh>
        {/* Sertifikat berbingkai kuningan */}
        <mesh position={[0.15, 0.16, -0.08]} rotation={[0.05, -0.15, 0]}>
          <boxGeometry args={[0.34, 0.26, 0.015]} />
          <meshStandardMaterial color="#f8fafc" roughness={0.5} />
        </mesh>
        <mesh position={[0.15, 0.16, -0.075]} rotation={[0.05, -0.15, 0]}>
          <boxGeometry args={[0.36, 0.28, 0.01]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
        </mesh>
      </group>
    </group>
  );
}

export function ExecutiveDesk() {
  const shape = useMemo(() => executiveTopShape(), []);
  const woodTop = useMemo(() => ({
    depth: 0.065, bevelEnabled: true, bevelSegments: 2, steps: 1,
    bevelSize: 0.018, bevelThickness: 0.018, curveSegments: 8
  }), []);

  return (
    <group>
      {/* Permukaan meja kayu smoked walnut gelap mewah dengan bevel halus */}
      <mesh castShadow receiveShadow userData={{ officeCollision: false }} position={[0, 0.825, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <extrudeGeometry args={[shape, woodTop]} />
        <meshStandardMaterial color="#2d221a" roughness={0.38} />
      </mesh>
      {/* Lis bevel bawah meja berlapis kuningan champagne mewah */}
      <mesh castShadow receiveShadow userData={{ officeCollision: false }} position={[0, 0.744, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <extrudeGeometry args={[shape, { depth: 0.035, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 8 }]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.82} roughness={0.24} />
      </mesh>

      {/* The visual desktop is L shaped. Use two matching collision arms so
          the empty CEO-side corner remains a walkable chair approach. */}
      <mesh position={[0.03, 0.78, 0.03]} visible={false}>
        <boxGeometry args={[4.55, 0.18, 1.2]} />
        <meshBasicMaterial />
      </mesh>
      <mesh position={[-1.71, 0.78, -1.52]} visible={false}>
        <boxGeometry args={[1.06, 0.18, 1.9]} />
        <meshBasicMaterial />
      </mesh>

      {/* Desk blotter kulit saddle hitam pekat dengan lis jahitan emas */}
      <mesh receiveShadow position={[0.29, 0.839, -0.16]}>
        <boxGeometry args={[2.48, 0.013, 0.70]} />
        <meshStandardMaterial color="#1a1816" roughness={0.88} />
      </mesh>
      <mesh position={[0.29, 0.847, 0.19]}>
        <boxGeometry args={[2.48, 0.004, 0.014]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* Modesty panel depan dengan aksen kayu gelap berfluting */}
      <mesh castShadow receiveShadow position={[0.3, 0.385, 0.49]}>
        <boxGeometry args={[3.02, 0.59, 0.12]} />
        <meshStandardMaterial color="#241b15" roughness={0.5} />
      </mesh>
      <mesh position={[0.3, 0.69, 0.554]}>
        <boxGeometry args={[3.04, 0.025, 0.018]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.82} roughness={0.24} />
      </mesh>
      {/* Pendar LED lantai di bawah meja depan */}
      <mesh position={[0.3, 0.04, 0.48]}>
        <boxGeometry args={[2.9, 0.01, 0.02]} />
        <meshStandardMaterial color="#ffffff" emissive="#fbbf24" emissiveIntensity={0.65} toneMapped={false} />
      </mesh>

      {/* Kaki / Pedestal kanan & credenza return kiri */}
      <mesh castShadow position={[1.96, 0.38, 0.04]}>
        <boxGeometry args={[0.59, 0.68, 0.96]} />
        <meshStandardMaterial color="#261e18" roughness={0.45} />
      </mesh>
      <mesh castShadow position={[-1.72, 0.38, -1.93]}>
        <boxGeometry args={[0.92, 0.68, 0.96]} />
        <meshStandardMaterial color="#261e18" roughness={0.45} />
      </mesh>

      {/* Aksen slat fluted pada sisi samping meja */}
      {Array.from({ length: 5 }, (_, index) => (
        <mesh key={`right-slat-${index}`} castShadow position={[2.264, 0.37, -0.32 + index * 0.16]}>
          <boxGeometry args={[0.025, 0.57, 0.057]} />
          <meshStandardMaterial color="#1a1410" roughness={0.55} />
        </mesh>
      ))}
      {Array.from({ length: 5 }, (_, index) => (
        <mesh key={`return-slat-${index}`} castShadow position={[-2.193, 0.37, -2.26 + index * 0.16]}>
          <boxGeometry args={[0.025, 0.57, 0.057]} />
          <meshStandardMaterial color="#1a1410" roughness={0.55} />
        </mesh>
      ))}

      {/* Handle laci credenza return berbahan kuningan */}
      {[0.22, 0.38, 0.54].map((y) => (
        <mesh key={y} position={[-1.7, y, -1.443]}>
          <boxGeometry args={[0.72, 0.014, 0.014]} />
          <meshStandardMaterial color="#cfa45d" metalness={0.85} roughness={0.25} />
        </mesh>
      ))}
      <mesh position={[1.69, 0.85, -0.37]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.062, 20]} />
        <meshStandardMaterial color="#221d18" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Lampu meja desainer modern kuningan champagne & cangkir espresso */}
      <mesh castShadow position={[1.83, 0.875, 0.29]}>
        <cylinderGeometry args={[0.09, 0.105, 0.05, 20]} />
        <meshStandardMaterial color="#1c1917" metalness={0.8} roughness={0.25} />
      </mesh>
      <mesh castShadow position={[1.83, 0.975, 0.29]}>
        <cylinderGeometry args={[0.018, 0.018, 0.17, 12]} />
        <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
      </mesh>
      <mesh castShadow position={[1.83, 1.105, 0.29]}>
        <sphereGeometry args={[0.13, 20, 14]} />
        <meshStandardMaterial color="#fff4d4" emissive="#d49b4b" emissiveIntensity={0.65} metalness={0.1} roughness={0.2} />
      </mesh>

      <mesh castShadow position={[-1.72, 0.875, -1.3]}>
        <cylinderGeometry args={[0.075, 0.065, 0.11, 16]} />
        <meshStandardMaterial color="#e8dfcf" roughness={0.3} />
      </mesh>
      <mesh position={[-1.72, 0.935, -1.3]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.06, 16]} />
        <meshStandardMaterial color="#75583c" roughness={0.68} />
      </mesh>
    </group>
  );
}

export function ExecutiveWorkstation({
  position = [0, 0, 0],
  rotationY = 0,
  screens,
  leaderSeat = EXECUTIVE_LEADER_SEAT,
  guestSeats = EXECUTIVE_OFFICE_BLUEPRINT.guestSeats,
  includeCabinet = true,
  cabinetWidth = 5.2,
  plant = true
}: {
  position?: readonly [number, number, number] | [number, number, number];
  rotationY?: number;
  screens: readonly [SmartScreenData, SmartScreenData, SmartScreenData] | [SmartScreenData, SmartScreenData, SmartScreenData];
  leaderSeat?: { position: readonly [number, number, number] | [number, number, number]; rotationY: number };
  guestSeats?: readonly { id: string; position: readonly [number, number, number] | [number, number, number]; rotationY: number }[];
  includeCabinet?: boolean;
  cabinetWidth?: number;
  plant?: boolean;
}) {
  return (
    <group position={[...position]} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
      {/* Rear modern luxury millwork cabinet: behind the CEO */}
      {includeCabinet && <ExecutiveLuxuryCabinet position={[0.1, 0, -3.15]} width={cabinetWidth} />}

      <ExecutiveDesk />

      {/* Screens face -Z, toward the CEO seat. */}
      <Monitor
        position={[-0.45, 1.27, -0.22]}
        rotationY={Math.PI + 0.12}
        width={0.72}
        height={0.42}
        variant="chart"
        data={screens[0]}
      />
      <Monitor
        position={[0.35, 1.30, -0.30]}
        rotationY={Math.PI}
        width={0.86}
        height={0.50}
        data={screens[1]}
      />
      <Monitor
        position={[1.17, 1.27, -0.22]}
        rotationY={Math.PI - 0.12}
        width={0.72}
        height={0.42}
        variant="ops"
        data={screens[2]}
      />

      <Keyboard
        position={[0.35, 0.842, -0.43]}
        rotationY={Math.PI}
      />
      <MouseAndPad position={[0.88, 0.832, -0.48]} rotationY={Math.PI} scale={1.08} />

      {/* Empty CEO chair until the final rigged avatar system is ready. */}
      <ExecutiveChair
        position={[...leaderSeat.position]}
        rotationY={leaderSeat.rotationY}
      />

      {/* Visitors face -Z toward the CEO. */}
      {guestSeats.map((seat) => <GuestChair
        key={seat.id}
        position={[...seat.position]}
        rotationY={seat.rotationY}
      />)}

      {plant && <Plant position={[2.55, 0, -2.45]} scale={1.1} />}
    </group>
  );
}
