/**
 * Small props for the seated idle moments: a coffee mug (sipping) and a phone
 * (on the phone). Geometry and materials are module-level singletons shared by
 * every character, built in metres with the origin at the object's base.
 * Parents place and scale them (the body is scaled, so they undo that scale);
 * they stay hidden except in their clip, and are never shown with reduced motion.
 */
import type { RefObject } from 'react';
import { InteriorPart } from '../interior/InteriorPart';
import type { Group } from 'three';
import { BoxGeometry, CylinderGeometry, MeshStandardMaterial, PlaneGeometry, TorusGeometry } from 'three';

const MUG_HEIGHT = 0.095;
const MUG_RADIUS = 0.04;
const MUG_BODY = new CylinderGeometry(MUG_RADIUS, MUG_RADIUS * 0.92, MUG_HEIGHT, 16, 1, true);
const MUG_BASE = new CylinderGeometry(MUG_RADIUS * 0.92, MUG_RADIUS * 0.92, 0.004, 16);
const MUG_COFFEE = new CylinderGeometry(MUG_RADIUS * 0.88, MUG_RADIUS * 0.88, 0.003, 16);
const MUG_HANDLE = new TorusGeometry(0.022, 0.0045, 6, 12, Math.PI);
const MUG_CERAMIC = new MeshStandardMaterial({ color: '#e9e4da', roughness: 0.3 });
const MUG_COFFEE_MATERIAL = new MeshStandardMaterial({ color: '#5b3b26', roughness: 0.25 });

const PHONE_BODY = new BoxGeometry(0.072, 0.0085, 0.146);
const PHONE_SCREEN = new PlaneGeometry(0.062, 0.128);
const PHONE_CASE = new MeshStandardMaterial({ color: '#1f2428', roughness: 0.35, metalness: 0.4 });
const PHONE_SCREEN_MATERIAL = new MeshStandardMaterial({ color: '#0f1a22', emissive: '#2d6e72', emissiveIntensity: 0.35, roughness: 0.2 });

/** A mug standing on its base, origin at the bottom centre. */
export function MugProp({ groupRef }: { groupRef?: RefObject<Group | null> | undefined }) {
  return (
    <group ref={groupRef} visible={false}>
      <InteriorPart model="drink-cup">
      <mesh geometry={MUG_BODY} material={MUG_CERAMIC} position={[0, MUG_HEIGHT / 2, 0]} />
      <mesh geometry={MUG_BASE} material={MUG_CERAMIC} position={[0, 0.002, 0]} />
      <mesh geometry={MUG_COFFEE} material={MUG_COFFEE_MATERIAL} position={[0, MUG_HEIGHT - 0.012, 0]} />
      <mesh geometry={MUG_HANDLE} material={MUG_CERAMIC} position={[MUG_RADIUS + 0.012, MUG_HEIGHT / 2, 0]} rotation={[0, 0, -Math.PI / 2]} />
      </InteriorPart>
    </group>
  );
}

/** A phone lying flat, screen up, origin at its centre. */
export function PhoneProp({ groupRef }: { groupRef?: RefObject<Group | null> | undefined }) {
  return (
    <group ref={groupRef} visible={false}>
      <mesh geometry={PHONE_BODY} material={PHONE_CASE} />
      <mesh geometry={PHONE_SCREEN} material={PHONE_SCREEN_MATERIAL} position={[0, 0.0045, 0]} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  );
}

/** A shared Blender dumbbell follows the actual wrist in either avatar renderer. */
export function DumbbellProp({ groupRef }: { groupRef?: RefObject<Group | null> | undefined }) {
  return <group ref={groupRef} visible={false}><InteriorPart model="dumbbell">
    <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.017, .017, .24, 12]} /><meshStandardMaterial color="#939ba3" metalness={.7} roughness={.25} /></mesh>
    {[-.1, .1].map(x => <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.065, .065, .05, 12]} /><meshStandardMaterial color="#343a43" /></mesh>)}
  </InteriorPart></group>;
}
