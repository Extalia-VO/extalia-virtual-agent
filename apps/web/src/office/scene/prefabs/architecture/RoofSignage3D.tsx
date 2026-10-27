/* eslint-disable react-hooks/immutability -- Three.js sign materials and canvas textures update in place. */
import { OFFICE_BUILDING } from "../../layout";
import { useEffect, useMemo } from "react";
import { AdditiveBlending, CanvasTexture, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace } from "three";
import { useSolarEnvironment } from "../../Environment";
import { createCodingMarkGeometry, createGlyphWordGeometry, glyphWordWidth } from "./extrudedGlyphs";

import {
  applyExtaliaMarkGradient, drawExtaliaBrand, emitMarkGradient, extaliaBrandLayout,
  EXTALIA_WORD as WORD, EXTALIA_WORD_COLOR, EXTALIA_WORDMARK_STYLE as WORDMARK_STYLE
} from "./extaliaBrand";

/**
 * Front-facing rooftop brand: /> coding emblem and lowercase Righteous lettering.
 * This sign is the brand reference; its mark gradient lives in extaliaBrand.ts.
 * Acrylic diffuser caps sit on darker channel returns. Two short-range,
 * shadowless lights spill onto the support rail and the adjacent roof membrane.
 */
export function RoofSignage3D({
  position = [OFFICE_BUILDING.west + 8.5, 21.08, OFFICE_BUILDING.north - 0.75],
  rotationY = Math.PI,
  size = 1.55,
  depth = 0.32,
  supportsFromModel = false
}: {
  position?: [number, number, number];
  rotationY?: number;
  size?: number;
  depth?: number;
  supportsFromModel?: boolean;
}) {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;

  const face = useMemo(() => createGlyphWordGeometry(WORD, {
    ...WORDMARK_STYLE, size, depth, bevel: Math.min(depth * 0.12, size * 0.012)
  }), [size, depth]);
  const icon = useMemo(() => applyExtaliaMarkGradient(createCodingMarkGeometry(size * 1.04, depth), size * 1.04), [size, depth]);
  const width = glyphWordWidth(WORD, size, WORDMARK_STYLE.tracking, WORDMARK_STYLE.typeface);
  const iconWidth = icon.boundingBox!.max.x - icon.boundingBox!.min.x;
  const gap = size * 0.38;
  const totalWidth = width + iconWidth + gap;
  const wordX = (iconWidth + gap) / 2;
  const iconX = -(width + gap) / 2;
  const softHalo = useMemo(() => {
    const pixelsPerMetre = 128;
    const padding = size * 0.32;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((extaliaBrandLayout(size).width + padding * 2) * pixelsPerMetre);
    canvas.height = Math.ceil((size * 1.04 + padding * 2) * pixelsPerMetre);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Transparent padding extends beyond three blur radii on every edge. Both
    // passes are blurred: there is no crisp duplicate silhouette behind the cap.
    for (const [blur, alpha] of [[0.09, 0.6], [0.035, 0.4]] as const) {
      ctx.filter = `blur(${size * pixelsPerMetre * blur}px)`;
      ctx.globalAlpha = alpha;
      drawExtaliaBrand(ctx, {
        centerX: canvas.width / 2, centerY: canvas.height / 2,
        height: size * pixelsPerMetre, wordColor: "#dcf0ff"
      });
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0, blending: AdditiveBlending,
      depthWrite: false, toneMapped: false
    });
    return { texture, material, width: canvas.width / pixelsPerMetre, height: canvas.height / pixelsPerMetre };
  }, [size]);

  const materials = useMemo(() => ({
    diffuser: new MeshStandardMaterial({
      color: EXTALIA_WORD_COLOR,
      metalness: 0,
      roughness: 0.32,
      emissive: "#f1f7ff",
      emissiveIntensity: 0
    }),
    // Gradient acrylic face keeps the reference colours in daylight and at night.
    symbol: emitMarkGradient(new MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.3,
      emissive: "#ffffff", emissiveIntensity: 0 })),
    returns: new MeshStandardMaterial({ color: "#75828e", metalness: 0.18, roughness: 0.38 }),
    symbolReturns: new MeshStandardMaterial({ color: "#70988d", vertexColors: true, metalness: 0.12, roughness: 0.38 }),
    frame: new MeshStandardMaterial({ color: "#1b1f24", metalness: 0.7, roughness: 0.4 }),
    strip: new MeshStandardMaterial({ color: "#466775", metalness: 0, roughness: 0.45,
      emissive: "#9cdaed", emissiveIntensity: 0 })
  }), []);

  useEffect(() => () => {
    face.dispose();
    icon.dispose();
  }, [face, icon]);
  useEffect(() => () => {
    softHalo.texture.dispose();
    softHalo.material.dispose();
  }, [softHalo]);
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);
  // A diffuser emits light; the deeper returns stay shaded so the box thickness
  // remains visible. Emission vanishes in daylight instead of lifting the scene.
  useEffect(() => {
    materials.diffuser.emissiveIntensity = night * 0.7;
    materials.symbol.emissiveIntensity = night * 0.85;
    softHalo.material.opacity = night * 0.16;
    materials.strip.emissiveIntensity = night * 0.12;
  }, [materials, softHalo, night]);

  return (
    <group position={position} rotation={[0, rotationY, 0]} name="extalia-roof-signage-3d" userData={{ officeDynamic: true }}>
      {/* Steel support rail and posts anchoring the sign to the parapet. */}
      {!supportsFromModel && <><mesh position={[0, -size / 2 - 0.12, -0.18]} material={materials.frame} receiveShadow>
        <boxGeometry args={[totalWidth + 0.6, 0.12, 0.22]} />
      </mesh>
      {[-0.5, -0.17, 0.17, 0.5].map((f) => (
        <mesh key={f} position={[f * totalWidth, -size / 2 - 0.45, -0.18]} material={materials.frame}>
          <boxGeometry args={[0.08, 0.6, 0.08]} />
        </mesh>
      ))}</>}
      <mesh position={[0, -size / 2 - 0.05, -0.06]} material={materials.strip}>
        <boxGeometry args={[totalWidth + 0.4, 0.025, 0.025]} />
      </mesh>
      {/* Soft acrylic backlight follows the actual letter outlines and spacing. */}
      <mesh name="extalia-roof-soft-halo" position={[0, 0, -0.08]} material={softHalo.material}>
        <planeGeometry args={[softHalo.width, softHalo.height]} />
      </mesh>
      {/* ExtrudeGeometry assigns index 0 to caps and index 1 to side returns. */}
      <mesh name="extalia-roof-acrylic-symbol" geometry={icon} position={[iconX, 0, 0]}
        material={[materials.symbol, materials.symbolReturns]} receiveShadow />
      <mesh name="extalia-roof-acrylic-wordmark" geometry={face} position={[wordX, 0, 0]}
        material={[materials.diffuser, materials.returns]} receiveShadow />
      {/* The rear acrylic glow faces the roof rather than the outside facade.
          Reuse the two existing emitters, keeping the GPU light count unchanged. */}
      <pointLight name="extalia-roof-symbol-spill" position={[iconX, -size * 0.25, -0.7]}
        color="#b0dc62" intensity={night * 4.5} distance={5} decay={2} castShadow={false} />
      <pointLight name="extalia-roof-wordmark-spill" position={[wordX, -size * 0.25, -0.7]}
        color="#e2f2ff" intensity={night * 6} distance={5} decay={2} castShadow={false} />
    </group>
  );
}
