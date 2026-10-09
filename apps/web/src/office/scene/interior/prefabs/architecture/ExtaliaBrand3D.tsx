import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { createCodingMarkGeometry, createGlyphWordGeometry } from "../../../prefabs/architecture/extrudedGlyphs";
import {
  applyExtaliaMarkGradient, emitMarkGradient, EXTALIA_WORD, EXTALIA_WORD_COLOR, EXTALIA_WORDMARK_STYLE, extaliaBrandLayout
} from "../../../prefabs/architecture/extaliaBrand";

/** Interior 3D brand matching the rooftop sign: gradient /> acrylic and light lowercase lettering. */
export function ExtaliaBrand3D({ height, depth = 0.07, lightFactor = 0, position = [0, 0, 0], rotationY = 0 }: {
  height: number; depth?: number; lightFactor?: number; position?: [number, number, number]; rotationY?: number;
}) {
  const geometry = useMemo(() => ({
    word: createGlyphWordGeometry(EXTALIA_WORD, { ...EXTALIA_WORDMARK_STYLE, size: height, depth, bevel: Math.min(depth * 0.12, height * 0.012) }),
    wordHalo: createGlyphWordGeometry(EXTALIA_WORD, { ...EXTALIA_WORDMARK_STYLE, size: height * 1.04, depth: 0.01, bevel: 0 }),
    icon: applyExtaliaMarkGradient(createCodingMarkGeometry(height * 1.04, depth, Math.min(depth * 0.12, height * 0.012)), height * 1.04),
    iconHalo: applyExtaliaMarkGradient(createCodingMarkGeometry(height * 1.09, 0.01, 0), height * 1.09)
  }), [height, depth]);
  const materials = useMemo(() => ({
    word: new MeshStandardMaterial({ color: EXTALIA_WORD_COLOR, metalness: 0, roughness: 0.32, emissive: "#f1f7ff" }),
    wordReturns: new MeshStandardMaterial({ color: "#75828e", metalness: 0.18, roughness: 0.38 }),
    icon: emitMarkGradient(new MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.1, roughness: 0.3, emissive: "#ffffff" })),
    iconReturns: new MeshStandardMaterial({ color: "#70988d", vertexColors: true, metalness: 0.12, roughness: 0.38 }),
    wordHalo: new MeshBasicMaterial({ color: "#dcf0ff", transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    iconHalo: new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
  }), []);
  const materialRef = useRef(materials);
  useEffect(() => () => Object.values(geometry).forEach(value => value.dispose()), [geometry]);
  useEffect(() => () => Object.values(materials).forEach(value => value.dispose()), [materials]);
  useEffect(() => {
    materialRef.current.word.emissiveIntensity = lightFactor * 0.55;
    materialRef.current.icon.emissiveIntensity = lightFactor * 0.65;
    materialRef.current.wordHalo.opacity = lightFactor * 0.1;
    materialRef.current.iconHalo.opacity = lightFactor * 0.1;
  }, [materials, lightFactor]);
  const { wordX, iconX } = extaliaBrandLayout(height);
  return <group position={position} rotation={[0, rotationY, 0]} name="extalia-brand-3d" userData={{ officeDynamic: true }}>
    <mesh geometry={geometry.wordHalo} position={[wordX, 0, -0.04]} material={materials.wordHalo} />
    <mesh geometry={geometry.iconHalo} position={[iconX, 0, -0.04]} material={materials.iconHalo} />
    {/* ExtrudeGeometry assigns index 0 to caps and index 1 to side returns. */}
    <mesh geometry={geometry.word} position={[wordX, 0, 0]} material={[materials.word, materials.wordReturns]} receiveShadow />
    <mesh geometry={geometry.icon} position={[iconX, 0, 0]} material={[materials.icon, materials.iconReturns]} receiveShadow />
  </group>;
}
