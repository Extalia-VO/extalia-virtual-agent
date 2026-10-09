import { useEffect, useMemo } from "react";
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

export type FloorMaterial = "oak" | "stone" | "carpet" | "tile" | "raised";

const PALETTE: Record<FloorMaterial, { base: string; edge: string; tileSize: number }> = {
  oak: { base: "#ceb792", edge: "#a98e6c", tileSize: 2.2 },
  stone: { base: "#ddd7cb", edge: "#c7bcad", tileSize: 3.2 },
  carpet: { base: "#aebdb5", edge: "#91a49b", tileSize: 2.5 },
  tile: { base: "#d9d1c3", edge: "#c0b4a3", tileSize: 2.4 },
  raised: { base: "#65747b", edge: "#39484f", tileSize: 2.5 }
};

function makeTexture(material: FloorMaterial, width: number, depth: number): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const { base, tileSize } = PALETTE[material];
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);

  if (material === "oak") {
    for (let row = 0; row < 8; row++) {
      const y = row * 32;
      ctx.fillStyle = row % 2 ? "rgba(111,76,46,.055)" : "rgba(255,255,255,.065)";
      ctx.fillRect(0, y + 2, 256, 28);
      ctx.strokeStyle = "rgba(89,65,48,.24)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
      const joint = (row % 3) * 85 + 32;
      ctx.beginPath(); ctx.moveTo(joint, y); ctx.lineTo(joint, y + 32); ctx.stroke();
      for (let n = 0; n < 3; n++) {
        ctx.strokeStyle = "rgba(99,65,40,.045)";
        ctx.beginPath(); ctx.moveTo(0, y + 9 + n * 6); ctx.lineTo(256, y + 7 + n * 6); ctx.stroke();
      }
    }
  } else if (material === "stone" || material === "tile") {
    const step = material === "tile" ? 64 : 128;
    ctx.strokeStyle = material === "tile" ? "rgba(133,124,113,.19)" : "rgba(119,111,101,.08)";
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += step) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    if (material === "stone") {
      for (let i = 0; i < 110; i++) {
        const x = (i * 73 + 19) % 256;
        const y = (i * 139 + 43) % 256;
        ctx.fillStyle = i % 4 === 0 ? "rgba(157,143,123,.22)" : "rgba(190,179,160,.15)";
        ctx.fillRect(x, y, i % 5 === 0 ? 4 : 2, i % 5 === 0 ? 2 : 3);
      }
    }
  } else if (material === "raised") {
    const step = 64;
    for (let y = 0; y < 256; y += step) {
      for (let x = 0; x < 256; x += step) {
        const variation = ((x / step + y / step) % 2) * 5;
        ctx.fillStyle = `rgb(${101 + variation}, ${116 + variation}, ${123 + variation})`;
        ctx.fillRect(x + 2, y + 2, step - 4, step - 4);
        ctx.strokeStyle = "rgba(25,39,45,.72)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, step - 2, step - 2);
        ctx.strokeStyle = "rgba(218,231,232,.17)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 5, y + 5, step - 10, step - 10);
        ctx.fillStyle = "rgba(25,39,45,.58)";
        for (const [dx, dy] of ([[8, 8], [step - 8, 8], [8, step - 8], [step - 8, step - 8]] as const)) {
          ctx.beginPath(); ctx.arc(x + dx, y + dy, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  } else {
    for (let i = 0; i < 256; i += 8) {
      ctx.strokeStyle = i % 16 === 0 ? "rgba(255,255,255,.06)" : "rgba(55,82,75,.045)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(width / tileSize, depth / tileSize);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function FloorFinish({
  size,
  position = [0, 0, 0],
  material = "oak",
  thickness = 0.08,
  border = false
}: {
  size: [number, number];
  position?: [number, number, number];
  material?: FloorMaterial;
  thickness?: number;
  border?: boolean;
}) {
  const [width, depth] = size;
  const texture = useMemo(() => makeTexture(material, width, depth), [material, width, depth]);
  useEffect(() => () => texture.dispose(), [texture]);
  const edge = PALETTE[material].edge;
  return (
    <group position={position} name="office-floor-finish" userData={{ officeCollision: false }}>
      <mesh receiveShadow position={[0, thickness / 2, 0]}>
        <boxGeometry args={[width, thickness, depth]} />
        <meshStandardMaterial map={texture} color="#ffffff" roughness={material === "stone" || material === "tile" || material === "raised" ? 0.76 : 0.91} />
      </mesh>
      {border && <>
        {[-1, 1].map((side) => <mesh key={`x-${side}`} receiveShadow position={[side * (width / 2 - 0.045), thickness + 0.005, 0]}>
          <boxGeometry args={[0.09, 0.012, depth]} /><meshStandardMaterial color={edge} roughness={0.82} />
        </mesh>)}
        {[-1, 1].map((side) => <mesh key={`z-${side}`} receiveShadow position={[0, thickness + 0.005, side * (depth / 2 - 0.045)]}>
          <boxGeometry args={[width, 0.012, 0.09]} /><meshStandardMaterial color={edge} roughness={0.82} />
        </mesh>)}
      </>}
    </group>
  );
}
