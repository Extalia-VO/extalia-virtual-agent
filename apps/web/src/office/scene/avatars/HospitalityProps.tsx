import { useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { InteriorPart } from '../interior/InteriorPart';
import type { CharacterMotion } from '../movement/walkCycle';
import type { HandGoals } from './handGoals';

/** Held props use the same wrist goals as both rigs, in unscaled seat-root metres. */
export function HospitalityProps({ motion, goals, reducedMotion }: {
  motion?: CharacterMotion | undefined;
  goals: RefObject<{ shown: HandGoals; target: HandGoals } | null>;
  reducedMotion: boolean;
}) {
  const controller = useRef<Group>(null), plate = useRef<Group>(null), bite = useRef<Group>(null);
  const serviceCup = useRef<Group>(null);
  useFrame(() => {
    const hands = goals.current?.shown;
    if (serviceCup.current) {
      const serving = !reducedMotion && (motion?.clip === 'bar-prep' || motion?.clip === 'bar-shake' || motion?.clip === 'bar-serve');
      serviceCup.current.visible = serving;
      serviceCup.current.position.set(.12, motion?.clip === 'bar-shake' ? 1.25 : 1.1, .4);
    }
    const seated = !reducedMotion && (motion?.sit ?? 0) > .8 && (motion?.walk ?? 0) < .05;
    const gaming = seated && motion?.clip === 'console-play';
    const eating = seated && motion?.clip === 'eat';
    if (controller.current) {
      controller.current.visible = gaming;
      if (hands) controller.current.position.set((hands.target[0][0] + hands.target[1][0]) / 2,
        (hands.target[0][1] + hands.target[1][1]) / 2, (hands.target[0][2] + hands.target[1][2]) / 2 + .025);
    }
    if (plate.current) {
      plate.current.visible = eating;
      if (hands) plate.current.position.set(hands.target[0][0] + .06, hands.target[0][1] + .015, hands.target[0][2] + .02);
    }
    if (bite.current) {
      bite.current.visible = eating;
      if (hands) bite.current.position.set(hands.target[1][0] - .02, hands.target[1][1] + .03, hands.target[1][2] + .025);
    }
  });
  return <>
    <group ref={serviceCup} visible={false}><InteriorPart model="drink-cup">
      <mesh position={[0, .05, 0]}><cylinderGeometry args={[.04, .033, .1, 16]} /><meshStandardMaterial color="#e4d5b6" /></mesh>
    </InteriorPart></group>
    <group ref={controller} visible={false}>
      <InteriorPart model="game-controller">
        <mesh><boxGeometry args={[.23, .045, .12]} /><meshStandardMaterial color="#ececf2" roughness={.45} /></mesh>
        {[-.06, .06].map(x => <mesh key={x} position={[x, .028, .01]}><cylinderGeometry args={[.018, .018, .014, 12]} /><meshStandardMaterial color="#222330" /></mesh>)}
      </InteriorPart>
    </group>
    <group ref={plate} visible={false}>
      <InteriorPart model="food-plate">
        <mesh><cylinderGeometry args={[.105, .09, .014, 24]} /><meshStandardMaterial color="#eee5d8" /></mesh>
        <mesh position={[0, .025, 0]}><boxGeometry args={[.09, .035, .065]} /><meshStandardMaterial color="#be8148" /></mesh>
      </InteriorPart>
    </group>
    <mesh ref={bite} visible={false}><boxGeometry args={[.035, .023, .025]} /><meshStandardMaterial color="#c69154" /></mesh>
  </>;
}
