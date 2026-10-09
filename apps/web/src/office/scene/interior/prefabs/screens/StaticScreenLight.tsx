import { useEffect, useRef } from "react";
import { Color, type Group } from "three";
import { registerScreenEmitter, type ScreenEmitter } from "./screenEmitterRegistry";
import { displayEmission } from "./screenPhotometry";

/**
 * Registers a fixed-content display (arcade game, equipment console) as a cached device
 * light. Like SmartScreen, the source faces this group's local +Z and keeps lighting its
 * surroundings when room lamps are off.
 */
export function StaticScreenLight({ position = [0, 0, 0], width, height, depth = 0.02, color, luminance }: {
  position?: [number, number, number]; width: number; height: number; depth?: number;
  /** Dominant displayed colour (sRGB hex). */
  color: string;
  /** Average linear luminance of the displayed content, 0..1. */
  luminance: number;
}) {
  const group = useRef<Group>(null);
  useEffect(() => {
    if (!group.current) return;
    const tint = new Color(color);
    const peak = Math.max(tint.r, tint.g, tint.b, 0.0001);
    const source: ScreenEmitter = {
      group: group.current, width, height, depth,
      intensity: displayEmission(width * height, luminance),
      color: [tint.r / peak, tint.g / peak, tint.b / peak]
    };
    return registerScreenEmitter(source);
  }, [width, height, depth, color, luminance]);
  return <group ref={group} position={position} />;
}
