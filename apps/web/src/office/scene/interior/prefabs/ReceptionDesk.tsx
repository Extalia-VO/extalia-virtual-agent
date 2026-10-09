import { useEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace } from "three";
import { Monitor } from "./props/Monitor";
import { OfficeChair } from "./furniture/OfficeChair";
import { useSolarEnvironment } from "../../Environment";
import { RECEPTION_DESK_BLUEPRINT } from "../spatialBlueprints";
import { ReceptionBackdrop } from "./architecture/ReceptionBackdrop";
import { drawExtaliaBrand } from "../../prefabs/architecture/extaliaBrand";

import { useInteriorText } from "../FurnishedFloorContext";

/**
 * Creates dynamic high-resolution texture for the Extalia feature wall.
 * Warm bronze/champagne panels with reveal joints and the shared Extalia brand.
 * Matched to the reference corporate reception architecture.
 */
function createExtaliaWallTexture(subtitle: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new CanvasTexture(canvas);

  // Background warm architectural bronze / champagne metallic paneling
  const bgGrad = ctx.createLinearGradient(0, 0, 1024, 0);
  bgGrad.addColorStop(0, "#2c2824");
  bgGrad.addColorStop(0.3, "#3d3731");
  bgGrad.addColorStop(0.7, "#36302a");
  bgGrad.addColorStop(1, "#26221f");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1024, 512);

  // Architectural Vertical Panel Reveal Joints (thin reveal grooves)
  const panelWidths = [180, 240, 240, 240, 124];
  let curX = 0;
  for (const pw of panelWidths) {
    curX += pw;
    // Dark reveal groove
    ctx.fillStyle = "#12100e";
    ctx.fillRect(curX - 2, 0, 4, 512);
    // Subtle metallic highlight edge
    ctx.fillStyle = "rgba(224, 195, 155, 0.15)";
    ctx.fillRect(curX + 2, 0, 1.5, 512);
  }

  // Left decorative backlit chevron / geometric pattern (from reference photo)
  for (let row = 0; row < 6; row++) {
    const cy = 120 + row * 45;
    const cx = 90;
    ctx.strokeStyle = "rgba(230, 200, 150, 0.4)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 24, cy - 10);
    ctx.lineTo(cx, cy + 12);
    ctx.lineTo(cx + 24, cy - 10);
    ctx.stroke();
  }

  // Center Plaque Plate (Dark Bronze Brushed Plate with Gold Trim)
  const plaqueW = 680;
  const plaqueH = 200;
  const plaqueX = (1024 - plaqueW) / 2 + 30;
  const plaqueY = (512 - plaqueH) / 2 - 15;

  ctx.fillStyle = "#1e1b17";
  ctx.beginPath();
  ctx.roundRect(plaqueX, plaqueY, plaqueW, plaqueH, 12);
  ctx.fill();

  // Plaque perimeter gold frame
  ctx.strokeStyle = "#d4af37";
  ctx.lineWidth = 4;
  ctx.stroke();

  // Shared gradient /> symbol and lowercase Righteous wordmark, as on the rooftop.
  ctx.shadowColor = "rgba(196, 218, 255, 0.6)";
  ctx.shadowBlur = 18;
  drawExtaliaBrand(ctx, {
    centerX: 542,
    centerY: plaqueY + 84,
    height: 60,
    maxWidth: plaqueW - 80
  });

  // Architectural subtitle retains its descriptive typeface.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Subtitle: "OFFICE & INNOVATION CAMPUS"
  ctx.shadowColor = "rgba(255, 218, 140, 0.5)";
  ctx.shadowBlur = 8;
  ctx.font = "600 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.fillStyle = "#edd29d";
  ctx.letterSpacing = "6px";
  ctx.fillText(subtitle, 542, plaqueY + 138);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a dedicated emissive map for the Extalia brand and plaque.
 * The black background isolates the brand, subtitle, and decorative trim glow.
 */
function createExtaliaEmissiveTexture(subtitle: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new CanvasTexture(canvas);

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 1024, 512);

  const plaqueW = 680;
  const plaqueH = 200;
  const plaqueX = (1024 - plaqueW) / 2 + 30;
  const plaqueY = (512 - plaqueH) / 2 - 15;

  // Outer ambient glow behind plaque
  const glow = ctx.createRadialGradient(542, plaqueY + plaqueH / 2, 30, 542, plaqueY + plaqueH / 2, plaqueW / 1.6);
  glow.addColorStop(0, "rgba(255, 210, 130, 0.55)");
  glow.addColorStop(0.6, "rgba(255, 180, 80, 0.2)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(plaqueX - 40, plaqueY - 40, plaqueW + 80, plaqueH + 80);

  // Plaque border glow
  ctx.strokeStyle = "#ffd78a";
  ctx.lineWidth = 4;
  ctx.strokeRect(plaqueX, plaqueY, plaqueW, plaqueH);

  // Brand glow matches the wall texture, including the gradient /> symbol.
  ctx.shadowColor = "rgba(196, 218, 255, 0.8)";
  ctx.shadowBlur = 24;
  drawExtaliaBrand(ctx, {
    centerX: 542,
    centerY: plaqueY + 84,
    height: 60,
    maxWidth: plaqueW - 80,
    wordColor: "#ffffff"
  });

  // Subtitle
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#ffe0a0";
  ctx.shadowBlur = 10;
  ctx.font = "600 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.fillStyle = "#ffe4b0";
  ctx.letterSpacing = "6px";
  ctx.fillText(subtitle, 542, plaqueY + 138);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Modern Multi-Level Illuminated Reception Desk & Architectural Feature Wall.
 *
 * Diadaptasi dari referensi arsitektural modern (img_fe5d69fa8f60.png):
 * 1. Meja resepsionis glossy white dua tingkat (two-tier asymmetrical solid surface).
 * 2. Lampu LED cyan / ice blue pada plinth toe-kick dasar meja yang membasuh lantai.
 * 3. Saluran lampu aksen LED geometris memanjang pada fasia depan meja resepsionis.
 * 4. Lampu LED cove tersembunyi di bawah overhang counter transaksi.
 * 5. Tiga lampu gantung pendant kaca amber bertingkat (staggered blown-glass pendants).
 * 6. Vertical Living Green Wall (dinding taman moss / tanaman hijau) di sisi backdrop.
 * 7. Papan dinding fitur Extalia dengan lampu sorot arsitektural brass dan backlight logo.
 */
export function ReceptionDesk({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  const t = useInteriorText();
  const subtitle = t("OFFICE & INNOVATION CAMPUS");
  const wallTexture = useMemo(() => createExtaliaWallTexture(subtitle), [subtitle]);
  const emissiveTexture = useMemo(() => createExtaliaEmissiveTexture(subtitle), [subtitle]);
  useEffect(() => () => { wallTexture.dispose(); emissiveTexture.dispose(); }, [wallTexture, emissiveTexture]);

  const { state } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  const emissivePower = interiorFactor * 0.65;
  const deskLedIntensity = interiorFactor * 0.85;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* ============================================================ */}
      {/* 1. ARCHITECTURAL FEATURE BACKDROP WALL & SIGNAGE             */}
      {/* ============================================================ */}
      <group position={[0, 0, RECEPTION_DESK_BLUEPRINT.featureWallOffsetZ]}>
        {/* Wall Frame / Base structure */}
        <mesh position={[0, 1.45, 0]} castShadow receiveShadow>
          <boxGeometry args={[5.2, 2.7, 0.08]} />
          <meshStandardMaterial color="#221e1a" roughness={0.6} metalness={0.3} />
        </mesh>

        {/* Feature wall front surface with bronze panels and Extalia branding. */}
        <mesh position={[0, 1.45, -0.045]} rotation={[0, Math.PI, 0]} receiveShadow userData={{ officeDynamic: true }}>
          <planeGeometry args={[5.0, 2.5]} />
          <meshStandardMaterial
            map={wallTexture}
            emissiveMap={emissiveTexture}
            emissive="#ffffff"
            emissiveIntensity={emissivePower}
            roughness={0.35}
            metalness={0.45}
            side={DoubleSide}
            toneMapped={false}
          />
        </mesh>

        {/* ============================================================ */}
        {/* VERTICAL LIVING PLANT / GREEN WALL (from reference photo)    */}
        {/* Sisi kanan dinding aksen dihiasi panel tanaman vertikal      */}
        {/* ============================================================ */}
        <group position={[2.15, 1.45, -0.055]}>
          {/* Green wall dark frame */}
          <mesh>
            <boxGeometry args={[0.7, 2.45, 0.04]} />
            <meshStandardMaterial color="#1a1c18" roughness={0.8} />
          </mesh>
          {/* Lush foliage surface tiles with biological multi-tone green */}
          <mesh position={[0, 0, -0.025]}>
            <planeGeometry args={[0.62, 2.38]} />
            <meshStandardMaterial color="#2d5e3f" roughness={0.9} />
          </mesh>
          {/* Top accent grow light for living wall */}
          <mesh position={[0, 1.18, -0.06]}>
            <boxGeometry args={[0.6, 0.03, 0.05]} />
            <meshBasicMaterial color="#d4edda" />
          </mesh>
        </group>

        {/* V2 feature wall: oak slats, dark metal trim, backlit 3D Extalia brand.
            Covers x -2.45..1.75 so the living wall on the right stays visible. */}
        <ReceptionBackdrop position={[-0.35, 1.45, -0.05]} interiorFactor={interiorFactor} />

        {/* ============================================================ */}
        {/* ARSITEKTUR LAMPU DINDING PAPAN NAMA (LOGO GRAZING FIXTURE)   */}
        {/* ============================================================ */}
        <group position={[0, 2.62, -0.3]}>
          {/* Sleek brass mounting bracket arms */}
          {[-1.6, -0.6, 0.6, 1.6].map((bx, idx) => (
            <mesh key={`arm-${idx}`} position={[bx, 0, 0.12]}>
              <boxGeometry args={[0.03, 0.03, 0.24]} />
              <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.15} />
            </mesh>
          ))}

          {/* Picture light bar cylinder */}
          <mesh castShadow position={[0, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.03, 0.03, 4.2, 16]} />
            <meshStandardMaterial color="#dfb268" metalness={0.92} roughness={0.15} />
          </mesh>

          {/* Continuous warm linear LED diffuser */}
          <mesh position={[0, -0.025, 0]} userData={{ officeDynamic: true }}>
            <boxGeometry args={[4.0, 0.015, 0.035]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#fff2d6"
              emissiveIntensity={interiorFactor * 0.85}
              toneMapped={false}
            />
          </mesh>

          {/* 3 focused downward grazing lights illuminating the Extalia brand. */}
        </group>

        {/* Soft fill grazing light focused directly on the Extalia wordmark. */}

        {/* Back face architectural cove (South-facing / towards inner glass wall) */}
        <mesh position={[0, 2.68, 0.045]}>
          <boxGeometry args={[5.0, 0.02, 0.02]} />
          <meshBasicMaterial color="#ffe3a8" />
        </mesh>
      </group>

      {/* ============================================================ */}
      {/* 2. RECEPTIONIST CHAIR & SEATING SPACE                        */}
      {/* ============================================================ */}
      <group position={[RECEPTION_DESK_BLUEPRINT.staffOffsetX, 0, 0]} userData={{ officeSeatStation: true }}>
      <OfficeChair position={[0, 0, RECEPTION_DESK_BLUEPRINT.chairOffsetZ]} rotationY={Math.PI} />

      {/* ============================================================ */}
      {/* 3. MODERN SCULPTURAL RECEPTION DESK WITH INTEGRATED LEDS     */}
      {/* Sesuai foto referensi user (img_fe5d69fa8f60.png)            */}
      {/* Glossy white multi-level desk + cyan / ice blue LED channels */}
      {/* ============================================================ */}
      <group position={[0, 0, RECEPTION_DESK_BLUEPRINT.counterOffsetZ]}>

        {/* --- RECESSED BASE PLINTH (TOE-KICK) WITH WARM GOLD LED STRIP --- */}
        {/* Recessed dark kick base */}
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[3.82, 0.08, 0.78]} />
          <meshStandardMaterial color="#111317" roughness={0.8} />
        </mesh>

        {/* Front Toe-Kick Warm Gold LED Strip Plinth (Keliling Dasar Meja) */}
        <mesh position={[0, 0.045, -0.41]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[3.84, 0.03, 0.03]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity}
            toneMapped={false}
          />
        </mesh>

        {/* Left and Right Return Toe-Kick LED Strips */}
        <mesh position={[-1.91, 0.045, 0]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[0.03, 0.03, 0.78]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[1.91, 0.045, 0]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[0.03, 0.03, 0.78]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity}
            toneMapped={false}
          />
        </mesh>

        {/* Physical Warm Floor-Washing Point Lights from Desk Plinth */}

        {/* --- TWO-TIER SCULPTURAL DESK BODY (WARM WALNUT & TRAVERTINE/LIMESTONE) --- */}
        {/* Diselaraskan dengan furniture kantor: smoked oak (#42362b), limestone (#c4b5a2), oak (#a77e58), brushed brass (#cfa45d) */}
        {/* Lower Left Tier (Accessible Height: 0.75m, width 1.7m) */}
        <group position={[-1.05, 0, 0]}>
          {/* Main lower front body (Smoked Oak / Walnut) */}
          <mesh position={[0, 0.42, -0.02]} castShadow receiveShadow>
            <boxGeometry args={[1.75, 0.68, 0.8]} />
            <meshStandardMaterial color="#42362b" roughness={0.75} metalness={0.12} />
          </mesh>
          {/* Front Fluted Wood Facing Panel */}
          <mesh position={[0, 0.42, -0.425]} castShadow receiveShadow>
            <boxGeometry args={[1.73, 0.66, 0.02]} />
            <meshStandardMaterial color="#4d3e33" roughness={0.8} metalness={0.1} />
          </mesh>
          {/* Lower countertop surface (Warm Honed Travertine / Limestone, selaras dengan sofa dan karpet lobi) */}
          <mesh position={[0, 0.76, 0]} castShadow receiveShadow>
            <boxGeometry args={[1.8, 0.05, 0.85]} />
            <meshStandardMaterial color="#c4b5a2" roughness={0.55} metalness={0.12} />
          </mesh>
          {/* Perimeter brass edge trim */}
          <mesh position={[0, 0.74, -0.42]}>
            <boxGeometry args={[1.81, 0.015, 0.015]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.25} />
          </mesh>
        </group>

        {/* Higher Right Tier (Privacy Transaction Counter: 1.05m, width 2.1m) */}
        <group position={[0.9, 0, 0]}>
          {/* Main upper front body (Smoked Oak / Walnut) */}
          <mesh position={[0, 0.54, -0.02]} castShadow receiveShadow>
            <boxGeometry args={[2.15, 0.92, 0.8]} />
            <meshStandardMaterial color="#42362b" roughness={0.75} metalness={0.12} />
          </mesh>
          {/* Front Fluted Wood Facing Panel */}
          <mesh position={[0, 0.54, -0.425]} castShadow receiveShadow>
            <boxGeometry args={[2.13, 0.9, 0.02]} />
            <meshStandardMaterial color="#4d3e33" roughness={0.8} metalness={0.1} />
          </mesh>
          {/* Raised Transaction Counter Top (Warm Honed Travertine / Limestone) */}
          <mesh position={[0, 1.02, -0.1]} castShadow receiveShadow>
            <boxGeometry args={[2.2, 0.06, 0.62]} />
            <meshStandardMaterial color="#c4b5a2" roughness={0.55} metalness={0.12} />
          </mesh>
          {/* Upper counter front brass edge nosing */}
          <mesh position={[0, 0.995, -0.41]}>
            <boxGeometry args={[2.21, 0.018, 0.015]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.25} />
          </mesh>

          {/* Under-counter hidden LED cove beneath the high transaction ledge */}
          <mesh position={[0, 0.98, -0.42]} userData={{ officeDynamic: true }}>
            <boxGeometry args={[2.16, 0.02, 0.03]} />
            <meshStandardMaterial
              color="#fef3c7"
              emissive="#fbbf24"
              emissiveIntensity={deskLedIntensity * 0.9}
              toneMapped={false}
            />
          </mesh>

          {/* Worksurface inside for receptionist behind upper counter (Standard Office Natural Oak #a77e58) */}
          <mesh position={[0, 0.74, 0.22]} receiveShadow>
            <boxGeometry args={[2.0, 0.04, 0.48]} />
            <meshStandardMaterial color="#a77e58" roughness={0.76} />
          </mesh>
        </group>

        {/* --- GEOMETRIC ACCENT REVEAL LED STRIP ON FRONT PANEL (from reference) --- */}
        {/* Horizontal LED strip along upper section */}
        <mesh position={[0.85, 0.88, -0.435]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[1.9, 0.025, 0.025]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity * 1.1}
            toneMapped={false}
          />
        </mesh>
        {/* Diagonal LED strip stepping down towards the base */}
        <mesh position={[-0.15, 0.66, -0.435]} rotation={[0, 0, -0.48]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[0.65, 0.025, 0.025]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity * 1.1}
            toneMapped={false}
          />
        </mesh>
        {/* Lower horizontal segment connecting to plinth */}
        <mesh position={[-0.9, 0.44, -0.435]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[1.1, 0.025, 0.025]} />
          <meshStandardMaterial
            color="#fef3c7"
            emissive="#fbbf24"
            emissiveIntensity={deskLedIntensity * 1.1}
            toneMapped={false}
          />
        </mesh>

        {/* Direct fill light from the desk's front face lighting */}

        {/* --- RECEPTIONIST WORKSTATION HARDWARE --- */}
        {/* Twin Slim Aluminum Desktop Displays (facing receptionist at +Z) */}
        <Monitor resourceId="lobby.receptionist" position={[-0.35, 0.76, 0.2]} rotationY={0.06} width={0.65} height={0.38} />
        <Monitor resourceId="lobby.receptionist" position={[0.65, 0.76, 0.2]} rotationY={-0.06} width={0.65} height={0.38} />

        {/* --- COUNTERTOP ACCESSORIES FROM REFERENCE PHOTO --- */}
        {/* Guest sign-in tablet on high transaction counter */}
        <mesh position={[1.4, 1.06, -0.15]} rotation={[0.4, 0, 0]} castShadow>
          <boxGeometry args={[0.26, 0.018, 0.18]} />
          <meshStandardMaterial color="#0f172a" metalness={0.9} roughness={0.15} />
        </mesh>
        {/* Modern Ceramic Flower Vase with Floral Arrangement on lower counter */}
        <group position={[-1.4, 0.78, -0.15]}>
          {/* Warm ivory glazed ceramic cylinder vase with brass base ring */}
          <mesh castShadow position={[0, 0.14, 0]}>
            <cylinderGeometry args={[0.07, 0.05, 0.28, 16]} />
            <meshStandardMaterial color="#ded4c5" roughness={0.2} metalness={0.1} />
          </mesh>
          <mesh position={[0, 0.015, 0]}>
            <cylinderGeometry args={[0.055, 0.055, 0.03, 16]} />
            <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
          </mesh>
          {/* Lush flower bouquet & orchids */}
          <mesh castShadow position={[0, 0.35, 0]}>
            <sphereGeometry args={[0.16, 12, 12]} />
            <meshStandardMaterial color="#f472b6" roughness={0.7} />
          </mesh>
          <mesh castShadow position={[0.06, 0.42, 0.04]}>
            <sphereGeometry args={[0.1, 8, 8]} />
            <meshStandardMaterial color="#fef08a" roughness={0.7} />
          </mesh>
          <mesh castShadow position={[-0.05, 0.38, -0.05]}>
            <sphereGeometry args={[0.12, 8, 8]} />
            <meshStandardMaterial color="#4ade80" roughness={0.8} />
          </mesh>
        </group>
      </group>
      </group>

      {/* ============================================================ */}
      {/* 4. OVERHEAD STAGGERED BLOWN-GLASS PENDANT LIGHTS             */}
      {/* 3 Modern amber-tinted teardrop pendants (from reference)     */}
      {/* Hanging directly over the transaction counter at Z = -1.65   */}
      {/* ============================================================ */}
      <group position={[RECEPTION_DESK_BLUEPRINT.staffOffsetX, 0, RECEPTION_DESK_BLUEPRINT.counterOffsetZ - 0.05]}>
        {[
          { x: 0.35, y: 1.95, h: 0.42, rad: 0.12, color: "#d97706", cableLen: 1.35 },
          { x: 0.85, y: 2.18, h: 0.36, rad: 0.11, color: "#b45309", cableLen: 1.12 },
          { x: 1.35, y: 1.82, h: 0.48, rad: 0.13, color: "#d97706", cableLen: 1.48 }
        ].map((pend, idx) => (
          <group key={`reception-pendant-${idx}`} position={[pend.x, 0, 0]}>
            {/* Slim brass suspension rod/cable from ceiling */}
            <mesh position={[0, pend.y + pend.cableLen / 2 + pend.h / 2, 0]}>
              <cylinderGeometry args={[0.008, 0.008, pend.cableLen, 8]} />
              <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
            </mesh>

            {/* Polished brass socket cap */}
            <mesh position={[0, pend.y + pend.h / 2 + 0.02, 0]}>
              <cylinderGeometry args={[0.038, 0.038, 0.06, 16]} />
              <meshStandardMaterial color="#e5c07b" metalness={0.95} roughness={0.15} />
            </mesh>

            {/* Glowing amber-gold glass shade */}
            <mesh position={[0, pend.y, 0]}>
              <cylinderGeometry args={[pend.rad * 0.7, pend.rad, pend.h, 16]} />
              <meshStandardMaterial
                color={pend.color}
                emissive="#f59e0b"
                emissiveIntensity={interiorFactor * 0.65}
                roughness={0.1}
                metalness={0.2}
                transparent
                opacity={0.88}
              />
            </mesh>

            {/* Internal glowing warm filament bulb */}
            <mesh position={[0, pend.y - 0.04, 0]}>
              <sphereGeometry args={[0.045, 12, 12]} />
              <meshBasicMaterial color="#fffbeb" />
            </mesh>

            {/* Dedicated warm point light casting hospitality glow */}
          </group>
        ))}
      </group>
    </group>
  );
}
