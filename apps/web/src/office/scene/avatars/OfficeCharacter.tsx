import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { Group } from 'three';
import type { OfficeAgent } from '../../presence';
import { characterAppearance, type AvatarVisualConfig, type CharacterAppearance } from './appearance';
import { createHumanoidRigProfile } from './rig';
import { Hand, HairStyle, Limb } from './CharacterParts';
import { HumanoidFace } from './HumanoidFace';
import { DetailedShoe, GarmentDetails, GarmentTorso, resolveWardrobe, SleeveCuff } from './AvatarWardrobe';

export type { CharacterAppearance } from './appearance';

export interface OfficeCharacterProps {
  agent: OfficeAgent;
  position: [number, number, number];
  rotationY?: number;
  seated?: boolean;
  selected?: boolean;
  onSelect: (id: string) => void;
  reducedMotion?: boolean;
  /** Optional saved appearance; identity and reported state remain presence-owned. */
  appearance?: CharacterAppearance;
}

export function officeCharacterStatusColor(agent: OfficeAgent): string {
  if (agent.pendingApprovalId || agent.status === 'blocked') return '#efaa45';
  if (agent.status === 'working') return '#36c69a';
  if (agent.status === 'thinking' || agent.status === 'delegating') return '#729eff';
  if (agent.status === 'waiting') return '#c99ae5';
  if (agent.status === 'stopping') return '#df9168';
  if (agent.status === 'unavailable') return '#cf7777';
  return '#92a4aa';
}

/** Original authored procedural geometry, isolated from persona and runtime stores. */
function CharacterMesh({ visual, seated, typing, reducedMotion }: {
  visual: AvatarVisualConfig; seated: boolean; typing: boolean; reducedMotion: boolean;
}) {
  const rig = useMemo(() => {
    const base = createHumanoidRigProfile(visual.identityId, { stature: visual.stature });
    if (visual.heightMeters === undefined) return base;
    const height = Math.max(1.45, Math.min(1.95, visual.heightMeters));
    const nominal = (base.proportions.standingHipHeight + base.proportions.headHeight + base.proportions.headRadius) * base.scale[1];
    const ratio = height / nominal;
    return { ...base, scale: base.scale.map(axis => axis * ratio) as [number, number, number] };
  }, [visual.identityId, visual.stature, visual.heightMeters]);
  const wardrobe = useMemo(() => resolveWardrobe(visual, rig.seed), [visual, rig.seed]);
  const p = rig.proportions;
  const body = useRef<Group>(null), torso = useRef<Group>(null), head = useRef<Group>(null);
  const leftArm = useRef<Group>(null), rightArm = useRef<Group>(null);
  const leftElbow = useRef<Group>(null), rightElbow = useRef<Group>(null);
  const leftLeg = useRef<Group>(null), rightLeg = useRef<Group>(null);
  const leftKnee = useRef<Group>(null), rightKnee = useRef<Group>(null);
  const leftHand = useRef<Group>(null), rightHand = useRef<Group>(null);
  const leftFingers = useRef<(Group | null)[]>([]), rightFingers = useRef<(Group | null)[]>([]);
  const skin = visual.skinTone ?? '#c79a82';
  const hair = visual.hairColor ?? '#302b2c';
  const sleeve = wardrobe.layer === 'blazer' || wardrobe.layer === 'cardigan' ? wardrobe.jacket : wardrobe.top;
  const watch = visual.accessories?.watch ? visual.accessories.watchStyle ?? 'classic' : undefined;
  useFrame(({ clock }) => {
    for (let ancestor = body.current; ancestor; ancestor = ancestor.parent as Group | null) if (!ancestor.visible) return;
    const time = reducedMotion ? 0 : clock.elapsedTime * rig.motion.tempo + rig.motion.phaseOffset;
    const hip = seated ? (0.45 + 0.04) / rig.scale[1] : p.standingHipHeight;
    const thigh = seated ? -Math.acos(Math.max(-0.25, Math.min(0.65, (hip - p.shinLength) / p.thighLength))) : 0;
    if (torso.current) {
      torso.current.position.y = hip + (reducedMotion ? 0 : Math.sin(time * rig.motion.breathRate) * 0.003);
      torso.current.rotation.x = seated ? 0.035 : 0;
      torso.current.rotation.z = reducedMotion ? 0 : Math.sin(time * 0.55) * 0.006;
    }
    if (head.current) head.current.rotation.y = reducedMotion ? 0 : Math.sin(time * 0.35) * 0.025;
    for (const [upper, lower, hand, leg, knee, phase] of [
      [leftArm, leftElbow, leftHand, leftLeg, leftKnee, 0],
      [rightArm, rightElbow, rightHand, rightLeg, rightKnee, Math.PI],
    ] as const) {
      if (upper.current) upper.current.rotation.x = seated ? -0.38 : 0;
      if (lower.current) lower.current.rotation.x = seated ? -1.08 : -0.06;
      if (hand.current) hand.current.rotation.x = typing && !reducedMotion ? Math.sin(time * 8 + phase) * 0.035 : 0;
      if (leg.current) { leg.current.position.y = hip; leg.current.rotation.x = thigh; }
      if (knee.current) knee.current.rotation.x = -thigh;
    }
  });
  return <group ref={body} scale={[...rig.scale]}>
    <group ref={torso} position={[0, p.standingHipHeight, 0]}>
      <GarmentTorso proportions={p} wardrobe={wardrobe} skin={skin} />
      <group ref={head} position={[0, p.headHeight, 0]} scale={visual.presentation === 'female' ? [0.94, 1, 0.96] : [1, 1, 1]}>
        <mesh castShadow><sphereGeometry args={[p.headRadius, 16, 12]} /><meshStandardMaterial color={skin} roughness={0.87} /></mesh>
        <HairStyle variant={visual.hairVariant} color={hair} radius={p.headRadius} skin={skin} />
        <HumanoidFace radius={p.headRadius} skin={skin} hair={hair} seed={rig.seed} accessories={visual.accessories} reducedMotion={reducedMotion} />
      </group>
      {([-1, 1] as const).map(side => <Limb key={side} pivot={[side * p.shoulderWidth / 2, p.shoulderHeight, 0]}
        upperLength={p.upperArmLength} lowerLength={p.forearmLength} radius={0.058} upperColor={sleeve}
        lowerColor={wardrobe.sleeve === 'long' ? sleeve : skin} fabric={wardrobe.sleeve === 'long'}
        upperTrim={wardrobe.sleeve === 'rolled' ? <SleeveCuff length={p.upperArmLength} radius={0.068} color={wardrobe.top} rolled /> : undefined}
        lowerTrim={wardrobe.sleeve === 'long' ? <SleeveCuff length={p.forearmLength} radius={0.058} color={wardrobe.top} rolled={false} /> : undefined}
        upperRef={side === -1 ? leftArm : rightArm} lowerRef={side === -1 ? leftElbow : rightElbow}>
        <Hand handRef={side === -1 ? leftHand : rightHand} fingerRefs={side === -1 ? leftFingers : rightFingers} skin={skin} watch={side === -1 ? watch : undefined} thumbSide={-side} />
      </Limb>)}
      <GarmentDetails proportions={p} wardrobe={wardrobe} badge={visual.accessories?.badge} />
    </group>
    {([-1, 1] as const).map(side => <Limb key={side} pivot={[side * p.hipWidth / 2, p.standingHipHeight, 0]} upperLength={p.thighLength} lowerLength={p.shinLength} radius={0.073} upperColor={wardrobe.bottom} lowerColor={wardrobe.bottom} upperRef={side === -1 ? leftLeg : rightLeg} lowerRef={side === -1 ? leftKnee : rightKnee}><DetailedShoe wardrobe={wardrobe} /></Limb>)}
  </group>;
}

/** Visual-only presence: animation never creates or infers a runtime task state. */
export function OfficeCharacter({ agent, position, rotationY = 0, seated = false, selected = false, onSelect, reducedMotion = false, appearance }: OfficeCharacterProps) {
  const visual = useMemo(() => ({ ...characterAppearance(agent.id), ...appearance, identityId: agent.id }), [agent.id, appearance]);
  const typing = seated && agent.control === 'managed' && agent.running && agent.status === 'working';
  const color = officeCharacterStatusColor(agent);
  const pick = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(agent.id); };
  return <group position={position} rotation={[0, rotationY, 0]} onClick={pick}>
    <CharacterMesh visual={visual} seated={seated} typing={typing} reducedMotion={reducedMotion} />
    <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.48, 0.55, 32]} /><meshBasicMaterial color={color} />
    </mesh>
    {selected && <mesh position={[0, 0.026, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.6, 0.7, 32]} /><meshBasicMaterial color="#d3eb7d" />
    </mesh>}
    <mesh position={[0, seated ? 0.7 : 0.9, seated ? 0.16 : 0]}>
      <boxGeometry args={[1.1, seated ? 1.5 : 1.9, 1.1]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  </group>;
}
