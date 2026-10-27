import { useSolarEnvironment } from "./Environment";
import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

/** Each rooftop motor's nominal speed (rad/s, sign = direction) and the blade angle it rests at. */
export const ROOF_FAN_MOTORS = Object.freeze([
  { speed: 2.15, phase: 0.13 },
  { speed: -2.72, phase: 0.61 },
  { speed: 3.08, phase: 1.04 },
  { speed: 2.43, phase: 1.49 },
  { speed: -3.37, phase: 1.92 },
  { speed: 2.89, phase: 2.38 },
  { speed: 3.56, phase: 2.83 },
  { speed: -2.31, phase: 3.31 }
]);

/** A motor runs this long (s) before its thermostat stops it, then rests this long before it starts again. */
export const FAN_RUN_SECONDS: readonly [number, number] = [9, 45];
export const FAN_REST_SECONDS: readonly [number, number] = [6, 24];
/** Spin-up is driven (fast); spin-down is the rotor coasting on its own inertia (slow). */
export const FAN_SPIN_UP_TAU = 1.4;
export const FAN_SPIN_DOWN_TAU = 2.2;
/** Below this (rad/s) a coasting rotor is held still by bearing friction. */
const FAN_STOP_SPEED = 0.12;
/** Longest step simulated in one frame (a hidden tab must not fling the blades). */
const MAX_STEP = 0.25;

export interface FanMotor {
  angle: number;
  velocity: number;
  on: boolean;
  /** Seconds left in the current run or rest. */
  timer: number;
  /** Target speed of the current run. */
  speed: number;
  readonly nominal: number;
  readonly random: () => number;
}

/** Small seeded generator (mulberry32): every motor draws from its own stream. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: () => number, [low, high]: readonly [number, number]) => low + random() * (high - low);

/**
 * One motor in a random point of its cycle: running or resting, part-way through,
 * so the eight never start, stop or turn in step. `seed` decides its whole schedule.
 */
export function createFanMotor(index: number, seed: number): FanMotor {
  const motor = ROOF_FAN_MOTORS[index % ROOF_FAN_MOTORS.length]!;
  const random = generator(Math.imul(index + 1, 2654435761) ^ Math.floor(seed * 4294967296));
  const on = random() < 0.7;
  const speed = motor.speed * (0.85 + random() * 0.3);
  return {
    angle: motor.phase, velocity: on ? speed : 0, on,
    timer: between(random, on ? FAN_RUN_SECONDS : FAN_REST_SECONDS) * random(),
    speed, nominal: motor.speed, random,
  };
}

/** Advance one motor: its thermostat switches it, and the rotor eases towards the running or stopped speed. */
export function stepFanMotor(motor: FanMotor, seconds: number): FanMotor {
  const dt = Math.min(MAX_STEP, Math.max(0, seconds));
  motor.timer -= dt;
  if (motor.timer <= 0) {
    motor.on = !motor.on;
    motor.timer = between(motor.random, motor.on ? FAN_RUN_SECONDS : FAN_REST_SECONDS);
    if (motor.on) motor.speed = motor.nominal * (0.85 + motor.random() * 0.3);
  }
  const target = motor.on ? motor.speed : 0;
  const tau = motor.on ? FAN_SPIN_UP_TAU : FAN_SPIN_DOWN_TAU;
  motor.velocity += (target - motor.velocity) * (1 - Math.exp(-dt / tau));
  if (!motor.on && Math.abs(motor.velocity) < FAN_STOP_SPEED) motor.velocity = 0;
  motor.angle = (motor.angle + motor.velocity * dt) % (Math.PI * 2);
  return motor;
}

/** One frame subscriber drives all eight rotors, each on its own schedule; housings and grilles stay static. */
export function RoofFanMotion({ rotors }: { rotors: RefObject<Group | null>[] }) {
  const { reducedMotion } = useSolarEnvironment();
  const motors = useRef<FanMotor[] | null>(null);
  useFrame((_, delta) => {
    if (reducedMotion) return;
    // A fresh schedule per visit; within a visit each motor keeps its own stream.
    motors.current ??= rotors.map((_, index) => createFanMotor(index, Math.random()));
    motors.current.forEach((motor, index) => {
      stepFanMotor(motor, delta);
      const rotor = rotors[index]?.current;
      if (rotor) rotor.rotation.y = motor.angle;
    });
  });
  return null;
}
