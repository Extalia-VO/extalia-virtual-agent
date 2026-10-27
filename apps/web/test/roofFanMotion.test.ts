import { describe, expect, it } from 'vitest';
import { createFanMotor, FAN_REST_SECONDS, FAN_RUN_SECONDS, ROOF_FAN_MOTORS, stepFanMotor } from '../src/office/scene/roofFanMotion';

const DT = 1 / 60;

/** Simulate one motor and record when it switches and how fast it turns. */
function run(index: number, seed: number, seconds: number) {
  const motor = createFanMotor(index, seed);
  const switches: { at: number; on: boolean }[] = [];
  let previous = motor.on, maxJump = 0, lastVelocity = motor.velocity, stoppedFor = 0, longestStop = 0;
  for (let t = 0; t < seconds; t += DT) {
    stepFanMotor(motor, DT);
    if (motor.on !== previous) { switches.push({ at: t, on: motor.on }); previous = motor.on; }
    maxJump = Math.max(maxJump, Math.abs(motor.velocity - lastVelocity));
    lastVelocity = motor.velocity;
    stoppedFor = motor.velocity === 0 ? stoppedFor + DT : 0;
    longestStop = Math.max(longestStop, stoppedFor);
  }
  return { motor, switches, maxJump, longestStop };
}

describe('rooftop fan motors', () => {
  it('stop and start again on their own, within the run and rest ranges', () => {
    const { switches, longestStop } = run(1, 0.42, 300);
    expect(switches.length).toBeGreaterThan(4);
    expect(switches.some(s => !s.on)).toBe(true);
    expect(switches.some(s => s.on)).toBe(true);
    // The blades really come to rest while the motor is off.
    expect(longestStop).toBeGreaterThan(1);
    for (let i = 1; i < switches.length; i++) {
      const length = switches[i]!.at - switches[i - 1]!.at;
      const [low, high] = switches[i - 1]!.on ? FAN_RUN_SECONDS : FAN_REST_SECONDS;
      expect(length).toBeGreaterThan(low - 0.1);
      expect(length).toBeLessThan(high + 0.1);
    }
  });

  it('spin up and coast down smoothly instead of jumping between speeds', () => {
    const { maxJump } = run(4, 0.17, 240);
    // The only step is bearing friction holding a rotor that has coasted below 0.12 rad/s (invisible).
    expect(maxJump).toBeLessThan(0.13);
  });

  it('are not linked: the eight motors switch at different moments', () => {
    const firstSwitches = ROOF_FAN_MOTORS.map((_, index) => run(index, 0.42, 120).switches[0]?.at ?? Infinity);
    expect(new Set(firstSwitches.map(at => at.toFixed(1))).size).toBe(ROOF_FAN_MOTORS.length);
  });

  it('keep each motor turning its own way at about its own speed', () => {
    ROOF_FAN_MOTORS.forEach(({ speed }, index) => {
      const motor = createFanMotor(index, 0.9);
      motor.on = true; motor.timer = 1e9;
      for (let t = 0; t < 15; t += DT) stepFanMotor(motor, DT);
      expect(Math.sign(motor.velocity)).toBe(Math.sign(speed));
      expect(Math.abs(motor.velocity)).toBeGreaterThan(Math.abs(speed) * 0.8);
      expect(Math.abs(motor.velocity)).toBeLessThan(Math.abs(speed) * 1.2);
    });
  });

  it('bounds a long frame so a hidden tab does not fling the blades', () => {
    const motor = createFanMotor(2, 0.5);
    motor.on = true; motor.timer = 1e9; motor.velocity = motor.speed;
    const before = motor.angle;
    stepFanMotor(motor, 30);
    const turned = Math.abs(((motor.angle - before) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    expect(Math.abs(motor.speed) * 0.25 + 1e-6).toBeGreaterThanOrEqual(Math.min(turned, Math.PI));
  });
});
