import { useSolarEnvironment } from "./Environment";
import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

/** Fixed motor settings prevent every rooftop rotor from starting in lockstep. */
export const ROOF_FAN_MOTORS = Object.freeze([
  { speed: 2.15, phase: 0.13, delay: 0 },
  { speed: -2.72, phase: 0.61, delay: 0.18 },
  { speed: 3.08, phase: 1.04, delay: 0.35 },
  { speed: 2.43, phase: 1.49, delay: 0.09 },
  { speed: -3.37, phase: 1.92, delay: 0.27 },
  { speed: 2.89, phase: 2.38, delay: 0.44 },
  { speed: 3.56, phase: 2.83, delay: 0.12 },
  { speed: -2.31, phase: 3.31, delay: 0.31 }
]);

export function roofFanAngle(index: number, elapsedSeconds: number) {
  const motor = ROOF_FAN_MOTORS[index]!;
  return motor.phase + motor.speed * Math.max(0, elapsedSeconds - motor.delay);
}

/** One frame subscriber drives all eight rotors; the housings and grilles stay static. */
export function RoofFanMotion({ rotors }: { rotors: RefObject<Group | null>[] }) {
  const { reducedMotion } = useSolarEnvironment();
  const startedAt = useRef<number | null>(null);
  useFrame(({ clock }) => {
    if (reducedMotion) return;
    startedAt.current ??= clock.elapsedTime;
    const elapsed = clock.elapsedTime - startedAt.current;
    rotors.forEach((rotor, index) => {
      if (rotor.current) rotor.current.rotation.y = roofFanAngle(index, elapsed);
    });
  });
  return null;
}
