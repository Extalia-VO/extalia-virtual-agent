/* eslint-disable react-hooks/immutability -- Three.js sign materials and canvas textures update in place. */
import { useEffect, useMemo } from "react";
import {
  AdditiveBlending, CanvasTexture, Float32BufferAttribute, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry,
  SRGBColorSpace, type BufferGeometry
} from "three";
import { useSolarEnvironment } from "../../Environment";
import { StaticCampusBatch } from "../../StaticCampusBatch";
import { createCodingMarkGeometry, createGlyphWordGeometry } from "./extrudedGlyphs";
import {
  applyExtaliaMarkGradient, drawExtaliaBrand, emitMarkGradient, extaliaBrandLayout,
  extaliaMarkColor, EXTALIA_WORD, EXTALIA_WORD_COLOR, EXTALIA_WORDMARK_STYLE
} from "./extaliaBrand";
import { EXTALIA_SIGNAGE_LAYOUT } from "./extaliaSignageLayout";

/**
 * Exterior brand signage for the campus entrance: the brand lockup (`/>` mark and
 * "extalia") on the canopy fascia over the door and a stone-and-metal front board
 * beside the arrival walkway. Letters are the same local font outlines and the same
 * mark gradient as the rooftop sign (extaliaBrand.ts).
 *
 * Night: exterior signage is lit by the time of day alone, never by the interior lights
 * switch. It uses emissive acrylic faces plus soft additive halo planes, with no real
 * GPU lights; every canvas is sized before its texture exists so the first upload is final
 * (resizing a canvas after upload leaves the texture blank).
 */

const GLOW_PIXELS_PER_METRE = 96;
/** Shared by every static (unlit-by-night) part so StaticCampusBatch merges them into one draw; colours bake into vertices. */
const STATIC_PBR = { roughness: 0.7, metalness: 0.12 } as const;
type Blur = ReadonlyArray<readonly [metres: number, alpha: number]>;

/** Fill closed font outlines (with counters) onto a canvas; y grows downwards there. */
/** A blurred silhouette that follows the lettering; null where canvas blur filters are unsupported. */
function createGlowTexture(
  widthMetres: number, heightMetres: number, blur: Blur,
  draw: (ctx: CanvasRenderingContext2D, centerX: number, centerY: number, pixelsPerMetre: number) => void
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(widthMetres * GLOW_PIXELS_PER_METRE);
  canvas.height = Math.ceil(heightMetres * GLOW_PIXELS_PER_METRE);
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.filter !== "string") return null;
  for (const [metres, alpha] of blur) {
    ctx.filter = `blur(${metres * GLOW_PIXELS_PER_METRE}px)`;
    ctx.globalAlpha = alpha;
    draw(ctx, canvas.width / 2, canvas.height / 2, GLOW_PIXELS_PER_METRE);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const glowMaterial = (texture: CanvasTexture) => new MeshBasicMaterial({
  map: texture, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false
});

/** Face and return materials shared by the extruded letters of one sign. */
function useBrandMaterials(night: number) {
  const materials = useMemo(() => ({
    // Light acrylic diffuser; emission is zero in daylight so it never lifts the scene.
    word: new MeshStandardMaterial({ color: EXTALIA_WORD_COLOR, metalness: 0, roughness: 0.32, emissive: "#f1f7ff", emissiveIntensity: 0 }),
    wordReturns: new MeshStandardMaterial({ color: "#75828e", metalness: 0.18, roughness: 0.38 }),
    // Gradient acrylic face: the vertex colours carry the teal → green → yellow stops by day and by night.
    symbol: emitMarkGradient(new MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.3, emissive: "#ffffff", emissiveIntensity: 0 })),
    symbolReturns: new MeshStandardMaterial({ color: "#70988d", vertexColors: true, metalness: 0.12, roughness: 0.38 }),
    trim: new MeshStandardMaterial({ color: "#aab4ba", ...STATIC_PBR })
  }), []);
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);
  useEffect(() => {
    materials.word.emissiveIntensity = night * 0.95;
    materials.symbol.emissiveIntensity = night * 1.15;
  }, [materials, night]);
  return materials;
}

function useDisposable(...items: Array<{ dispose(): void } | null>) {
  useEffect(() => () => items.forEach(item => item?.dispose()), items); // eslint-disable-line react-hooks/exhaustive-deps
}

/** `/>` plus lowercase wordmark, centred on the origin, back face on z = 0 and caps facing +z. */
function BrandLockup({ size, depth, night, glow = 0.3, pad = size * 0.32 }: {
  size: number; depth: number; night: number; /** Peak additive halo opacity at night. */ glow?: number; pad?: number;
}) {
  const materials = useBrandMaterials(night);
  const parts = useMemo(() => {
    const bevel = Math.min(depth * 0.12, size * 0.012);
    const layout = extaliaBrandLayout(size);
    const word = createGlyphWordGeometry(EXTALIA_WORD, { ...EXTALIA_WORDMARK_STYLE, size, depth, bevel });
    const icon = applyExtaliaMarkGradient(createCodingMarkGeometry(size * 1.04, depth, bevel), size * 1.04);
    const width = layout.width + pad * 2, height = size * 1.04 + pad * 2;
    const texture = createGlowTexture(width, height, [[size * 0.09, 0.6], [size * 0.035, 0.4]], (ctx, centerX, centerY, ppm) =>
      drawExtaliaBrand(ctx, { centerX, centerY, height: size * ppm, wordColor: "#dcf0ff" }));
    return { word, icon, layout, width, height, texture, halo: texture ? glowMaterial(texture) : null };
  }, [size, depth, pad]);
  useDisposable(parts.word, parts.icon, parts.texture, parts.halo);
  useEffect(() => { if (parts.halo) parts.halo.opacity = night * glow; }, [parts, night, glow]);
  return <group>
    {parts.halo && <mesh position={[0, 0, 0.004]} material={parts.halo}><planeGeometry args={[parts.width, parts.height]} /></mesh>}
    {/* ExtrudeGeometry assigns index 0 to the caps and index 1 to the side returns. */}
    <mesh geometry={parts.icon} position={[parts.layout.iconX, 0, 0]} material={[materials.symbol, materials.symbolReturns]} receiveShadow />
    <mesh geometry={parts.word} position={[parts.layout.wordX, 0, 0]} material={[materials.word, materials.wordReturns]} receiveShadow />
  </group>;
}

/** Lockup lettering on the canopy fascia, at head height over the door. */
/** Where the lettering hangs when the building model carries its own canopy sign (height and front face). */
export interface LintelPlacement { readonly y: number; readonly frontZ: number }

function EntranceLintel({ night, placement }: { night: number; placement?: LintelPlacement | undefined }) {
  const { x, size, depth } = EXTALIA_SIGNAGE_LAYOUT.lintel;
  const { y, frontZ } = placement ?? EXTALIA_SIGNAGE_LAYOUT.lintel;
  return <group name="extalia-entrance-lintel" position={[x, y, frontZ]} rotation={[0, Math.PI, 0]} userData={{ officeDynamic: true }}>
    <BrandLockup size={size} depth={depth} night={night} glow={0.4} pad={size * 0.5} />
  </group>;
}

/** Spaced capitals drawn at final size; the texture is created only after the canvas is complete. */
function createCaptionTexture(text: string, capHeightMetres: number, pixelsPerMetre = 420) {
  const px = capHeightMetres * pixelsPerMetre;
  const font = `600 ${(px / 0.72).toFixed(1)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const tracking = px * 0.34;
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d")!;
  measure.font = font;
  const letters = [...text];
  const advances = letters.map(letter => measure.measureText(letter).width);
  const textWidth = advances.reduce((sum, advance) => sum + advance, 0) + tracking * (letters.length - 1);
  const margin = px * 0.4;
  canvas.width = Math.ceil(textWidth + margin * 2);
  canvas.height = Math.ceil(px * 1.6);
  const ctx = canvas.getContext("2d")!;
  ctx.font = font; // resizing a canvas resets its context state
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#e4efec";
  let cursor = margin;
  letters.forEach((letter, index) => { ctx.fillText(letter, cursor, px * 1.3); cursor += advances[index]! + tracking; });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, width: canvas.width / pixelsPerMetre, height: canvas.height / pixelsPerMetre };
}

/** Horizontal strip carrying the mark gradient (teal → green → yellow) as vertex colours. */
function createGradientBar(width: number, height: number): BufferGeometry {
  const geometry = new PlaneGeometry(width, height, 12, 1);
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) extaliaMarkColor(positions.getX(i) / width + 0.5).toArray(colors, i * 3);
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Soft elliptical light pool for the ground in front of the board (additive decal, no light source). */
function createPoolTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 64, 0, 128, 64, 128);
  gradient.addColorStop(0, "rgba(205,255,232,0.85)");
  gradient.addColorStop(0.45, "rgba(160,235,196,0.32)");
  gradient.addColorStop(1, "rgba(160,235,196,0)");
  ctx.save();
  ctx.scale(1, 0.5);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  ctx.restore();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Front board: stone foot, charcoal plinth and brushed-metal board carrying the lockup and caption. */
function ForecourtBoard({ night }: { night: number }) {
  const { x, z, groundY, yawTowardsPath, footprint, face, wordSize } = EXTALIA_SIGNAGE_LAYOUT.board;
  const materials = useBrandMaterials(night);
  const parts = useMemo(() => {
    const caption = createCaptionTexture("VIRTUAL OFFICE", 0.19);
    return {
      caption, rule: createGradientBar(1.7, 0.028), pool: createPoolTexture(),
      captionMaterial: new MeshStandardMaterial({ map: caption.texture, emissiveMap: caption.texture, emissive: "#ffffff", emissiveIntensity: 0,
        roughness: 0.5, metalness: 0, transparent: true, alphaTest: 0.04, depthWrite: false }),
      ruleMaterial: emitMarkGradient(new MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.4, emissive: "#ffffff", emissiveIntensity: 0 })),
      strip: new MeshStandardMaterial({ color: "#8fb5a8", roughness: 0.45, emissive: "#c9ffe9", emissiveIntensity: 0 }),
      foot: new MeshStandardMaterial({ color: "#868c92", ...STATIC_PBR }),
      riser: new MeshStandardMaterial({ color: "#394148", ...STATIC_PBR }),
      board: new MeshStandardMaterial({ color: "#28323a", ...STATIC_PBR })
    };
  }, []);
  const poolMaterial = useMemo(() => new MeshBasicMaterial({ map: parts.pool, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), [parts.pool]);
  useDisposable(parts.caption.texture, parts.rule, parts.pool, parts.captionMaterial, parts.ruleMaterial, parts.strip,
    parts.foot, parts.riser, parts.board, poolMaterial);
  useEffect(() => {
    parts.captionMaterial.emissiveIntensity = night * 0.9;
    parts.ruleMaterial.emissiveIntensity = night * 0.9;
    parts.strip.emissiveIntensity = night * 1.1;
    poolMaterial.opacity = night * 0.6;
  }, [parts, poolMaterial, night]);

  const footHeight = 0.28, riserHeight = 0.5, revealHeight = 0.05;
  const boardBottom = footHeight - 0.02 + riserHeight + revealHeight;
  const boardTop = boardBottom + face[1];
  const boardZ = -0.2, faceZ = boardZ + 0.15;
  const lockupY = boardTop - 0.3 - wordSize * 0.52;
  const ruleY = boardBottom + 0.62, captionY = boardBottom + 0.4;
  return <group name="extalia-forecourt-board" position={[x, groundY, z]} rotation={[0, Math.PI - yawTowardsPath, 0]} userData={{ officeDynamic: true }}>
    <StaticCampusBatch>
      <mesh position={[0, footHeight / 2 - 0.02, 0]} material={parts.foot} castShadow receiveShadow>
        <boxGeometry args={[footprint[0], footHeight, footprint[1]]} />
      </mesh>
      <mesh position={[0, footHeight - 0.02 + riserHeight / 2, 0]} material={parts.riser} castShadow receiveShadow>
        <boxGeometry args={[footprint[0] - 0.5, riserHeight, footprint[1] - 0.45]} />
      </mesh>
      <mesh position={[0, boardBottom - revealHeight / 2, 0]} material={materials.trim} castShadow receiveShadow>
        <boxGeometry args={[footprint[0] - 0.44, revealHeight, footprint[1] - 0.39]} />
      </mesh>
      <mesh position={[0, boardBottom + face[1] / 2, boardZ]} material={parts.board} castShadow receiveShadow>
        <boxGeometry args={[face[0], face[1], 0.3]} />
      </mesh>
      <mesh position={[0, boardTop + 0.035, boardZ]} material={materials.trim} castShadow receiveShadow>
        <boxGeometry args={[face[0] + 0.1, 0.07, 0.42]} />
      </mesh>
    </StaticCampusBatch>
    <mesh position={[0, boardTop - 0.03, faceZ + 0.012]} material={parts.strip}><boxGeometry args={[face[0] - 0.4, 0.02, 0.02]} /></mesh>
    <group position={[0, lockupY, faceZ]}>
      <BrandLockup size={wordSize} depth={0.07} night={night} glow={0.42} />
    </group>
    <mesh geometry={parts.rule} position={[0, ruleY, faceZ + 0.006]} material={parts.ruleMaterial} />
    <mesh position={[0, captionY, faceZ + 0.008]} material={parts.captionMaterial}>
      <planeGeometry args={[parts.caption.width, parts.caption.height]} />
    </mesh>
    <mesh name="extalia-forecourt-board-pool" rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0, footprint[1] / 2 + 1.35]} material={poolMaterial}>
      <planeGeometry args={[7.2, 3.6]} />
    </mesh>
  </group>;
}

/** All exterior entrance signage; mounted with the campus layer so it hides with it. */
export function ExtaliaCampusSignage({ lintel }: { lintel?: LintelPlacement } = {}) {
  // Exterior signage follows the sky only (never the interior lights switch). It comes on at dusk;
  // the factor's 5% daytime floor is removed so the acrylic faces stay unlit in daylight.
  const lit = Math.max(0, (useSolarEnvironment().state.factors.signageLightFactor - 0.05) / 0.95);
  return <group name="extalia-campus-signage">
    <EntranceLintel night={lit} placement={lintel} />
    <ForecourtBoard night={lit} />
  </group>;
}
