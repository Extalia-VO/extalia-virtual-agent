import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Group } from 'three';
import type { OfficeAgent } from '../../presence';
import { avatarVisual, characterAppearance, characterRig, lookSeed, presentationPreset, type AvatarVisualConfig, type CharacterAppearance, type CharacterPresentation } from './appearance';
import { gaitParameters, idlePose } from './gait';
import { createWalkPose, writeWalkPose, type CharacterMotion, type WalkPose } from '../movement/walkCycle';
import { createClipDriver, stepClipDriver, type ClipDriver } from './activityPose';
import { createArmPoleSolution, solveArmPole } from './armPole';
import { solveArm3D, wristAngle, type Arm3DSolution } from './armIk';
import { createSeatedLegPose, floorSeatedKnee, seatedLegPose, supportedThigh } from './seatedPose';
import { deskReachForSeat, type DeskReach } from './deskReach';
import { createHandOrientationScratch, handPronationAngle, writeHandOrientation } from './handOrientation';
import { mixReachGoal } from './reachPose';
import { blendHandGoals, createHandGoals, PHONE_CENTRE, resolveDeskHandClip, writeHandGoals, type HandGoals } from './handGoals';
import { DumbbellProp, MugProp, PhoneProp } from './IdleProps';
import { bikeFootGoal, createFitnessLegSolution, fitnessHandGoal, fitnessMechanism, solveFitnessLeg } from "../interior/fitnessMechanics";
import { FITNESS_BLUEPRINT } from "../interior/spatialBlueprints";
import { HospitalityProps } from './HospitalityProps';
import { Bag, Earrings, Hand, HairStyle, Limb } from './CharacterParts';
import { HumanoidFace } from './HumanoidFace';
import { DetailedShoe, GarmentDetails, GarmentTorso, resolveWardrobe, SkirtDrape, SkirtYoke, SleeveCuff } from './AvatarWardrobe';
import { SourceHumanoid } from './SourceHumanoid';
import { SourcePieceAssets } from './SourcePieceAssets';
import { SourceAvatarBoundary } from './SourceAvatarBoundary';
import { sourceHairAsset } from './hairAssets';
import { sourceAvatarUrls } from './sourceAssets';
import { bindCharacterExpression, createFacialPose, expressionStateForAgent, expressionTimeSeconds, resolveCharacterExpression, writeFacialPose, type CharacterExpressionState } from './facialExpression';
import { HUMANOID_ARM_RADIUS, HUMANOID_HEAD_ELONGATION, HUMANOID_LEG_RADIUS } from './rig';
import { createLodState, lodStep, lodTier, screenHeightPixels, setCastShadows } from './avatarLod';

export type { CharacterAppearance } from './appearance';

export interface OfficeCharacterProps {
  agent: OfficeAgent;
  position: [number, number, number];
  rotationY?: number;
  seated?: boolean;
  seatHeight?: number;
  seatFront?: number;
  resourceId?: string | undefined;
  selected?: boolean;
  onSelect: (id: string) => void;
  reducedMotion?: boolean;
  /** Saved (or live-preview) appearance; identity and reported state remain presence-owned. */
  appearance?: CharacterAppearance | undefined;
  /** Live walk/sit blend written by the movement layer each frame; without it the pose follows `seated`. */
  motion?: CharacterMotion | undefined;
  /** Desk the character sits at: hand goals for seated desk work (the single desk without one). */
  desk?: DeskReach | undefined;
  /** Pointer entered / left the character's pick volume (drives the hover-only name tag). */
  onHoverStart?: (() => void) | undefined;
  onHoverEnd?: (() => void) | undefined;
}

/** Original authored procedural geometry, isolated from persona and runtime stores. */
/** Scratch for the arm solve and the torso transform, shared by every character (used synchronously within a frame). */
const armSolution: Arm3DSolution = { pitch: 0, elbow: 0, abduction: 0, error: 0 };
const deskArm = createArmPoleSolution();
const torsoInverse = new Matrix4();
const shoulderGoal = new Vector3();
const reachGoal: [number, number, number] = [0, 0, 0];
/** Fingers point across the keys with a slight downward angle. */
const FINGERS: [number, number, number] = [0, -0.14, 1];
const handOrientation = new Quaternion(), forearmPronation = new Quaternion();
const handOrientationScratch = createHandOrientationScratch();
const PROCEDURAL_FINGER_AXIS = [0, -1, 0] as const;
const FOREARM_AXIS = new Vector3(0, -1, 0);

function CharacterMesh({ visual, seated, typing, reducedMotion, motion, desk, resourceId, expressionId, expressionState = 'idle', seatHeight = 0.46, seatFront = 0.22 }: {
  resourceId?: string | undefined; visual: AvatarVisualConfig; seated: boolean; typing: boolean; reducedMotion: boolean; seatHeight?: number | undefined; seatFront?: number | undefined; motion?: CharacterMotion | undefined; desk?: DeskReach | undefined;
  expressionId?: string | undefined; expressionState?: CharacterExpressionState | undefined;
}) {
  const rig = useMemo(() => characterRig(visual), [visual]);
  const facialPose = useMemo(() => createFacialPose(), []);
  const gait = useMemo(() => gaitParameters({ gait: visual.gait, ...(visual.heightMeters ? { heightCm: visual.heightMeters * 100 } : {}) }), [visual.gait, visual.heightMeters]);
  const wardrobe = useMemo(() => resolveWardrobe(visual, rig.seed), [visual, rig.seed]);
  const p = rig.proportions;
  const seatedLeg = useMemo(() => createSeatedLegPose(), []);
  const fitnessLeg = useMemo(() => createFitnessLegSolution(), []);
  const fitnessFoot = useMemo(() => new Quaternion(), []);
  const skirt = wardrobe.bottomCut !== 'trousers';
  const bag = typeof visual.accessories?.bag === 'string' ? visual.accessories.bag : visual.accessories?.bag ? 'briefcase' : undefined;
  const body = useRef<Group>(null), torso = useRef<Group>(null), head = useRef<Group>(null), drape = useRef<Group>(null);
  const leftArm = useRef<Group>(null), rightArm = useRef<Group>(null);
  const leftElbow = useRef<Group>(null), rightElbow = useRef<Group>(null);
  const leftLeg = useRef<Group>(null), rightLeg = useRef<Group>(null);
  const leftKnee = useRef<Group>(null), rightKnee = useRef<Group>(null);
  const leftFoot = useRef<Group>(null), rightFoot = useRef<Group>(null);
  const leftHand = useRef<Group>(null), rightHand = useRef<Group>(null);
  const leftFingers = useRef<(Group | null)[]>([]), rightFingers = useRef<(Group | null)[]>([]);
  const skin = visual.skinTone ?? '#c79a82';
  const hair = visual.hairColor ?? '#302b2c';
  const sleeve = wardrobe.layer === 'blazer' || wardrobe.layer === 'cardigan' ? wardrobe.jacket : wardrobe.top;
  const watch = visual.accessories?.watch ? visual.accessories.watchStyle ?? 'classic' : undefined;
  const walkPose = useRef<WalkPose | null>(null);
  const clipDriver = useRef<ClipDriver | null>(null);
  const handGoals = useRef<{ shown: HandGoals; target: HandGoals } | null>(null);
  const mugLeft = useRef<Group>(null), mugRight = useRef<Group>(null);
  const weightLeft = useRef<Group>(null), weightRight = useRef<Group>(null);
  const phone = useRef<Group>(null);
  const reach = desk ?? deskReachForSeat(undefined);
  const invScale = [1 / rig.scale[0], 1 / rig.scale[1], 1 / rig.scale[2]] as [number, number, number];
  // Level of detail: the same body, posed less often and without shadows when small on screen.
  const lod = useRef(createLodState());
  useFrame(({ clock, camera, size }, frameDelta) => {
    for (let ancestor = body.current; ancestor; ancestor = ancestor.parent as Group | null) if (!ancestor.visible) return;
    let delta = frameDelta;
    if (body.current) {
      const tier = lodTier(screenHeightPixels(body.current, camera, size.height), lod.current.tier);
      if ((tier === 2) !== (lod.current.tier === 2)) setCastShadows(body.current, tier < 2);
      const step = lodStep(lod.current, tier, frameDelta);
      if (step === null) return;
      delta = step;
    }
    const time = reducedMotion ? 0 : clock.elapsedTime * rig.motion.tempo + rig.motion.phaseOffset;
    // `sit` blends the standing and seated poses while sitting down or standing up.
    const sit = motion ? motion.sit : seated ? 1 : 0;
    const walk = motion && !reducedMotion ? motion.walk : 0;
    const legLength = p.thighLength + p.shinLength;
    const stride = writeWalkPose(walkPose.current ??= createWalkPose(), gait, motion?.phase ?? 0, walk, legLength * rig.scale[1], motion?.stride ?? 1);
    seatedLegPose(seatHeight, seatFront, HUMANOID_LEG_RADIUS * rig.scale[1] + 0.008,
      p.thighLength * rig.scale[1], p.shinLength * rig.scale[1], -0.012 * rig.scale[1], HUMANOID_LEG_RADIUS * rig.scale[1], seatedLeg);
    const seatedHip = seatedLeg.hip / rig.scale[1];
    const equipment = fitnessMechanism(resourceId);
    const atFitness = walk < 0.1 && !!resourceId?.startsWith("fitness.");
    const deckLift = atFitness && motion?.clip === "jog" ? FITNESS_BLUEPRINT.treadmillDeckHeight / rig.scale[1] : 0;
    const hip = deckLift + p.standingHipHeight + (seatedHip - p.standingHipHeight) * sit + stride.bob / rig.scale[1];
    const thigh = seatedLeg.thigh * sit;
    // Gait-driven weight shift: pelvis sways over planted feet, shoulders counter-roll; the walk cycle takes over while walking.
    const pose = idlePose(gait, reducedMotion ? 0 : time, sit >= 0.5);
    // Activity clip (desk work, leisure, chat) over the base pose; static with reduced motion.
    // Idle props need motion: with reduced motion sipping and phone moments rest at the desk.
    const rawClip = resolveDeskHandClip(motion?.clip ?? 'none', sit, typing);
    const clip = reducedMotion && (rawClip === 'sip' || rawClip === 'phone') ? 'desk-idle' : rawClip;
    const activityTime = atFitness ? (equipment?.phase ?? 0) / 3.4 : time;
    const act = stepClipDriver(clipDriver.current ??= createClipDriver(), clip, activityTime, delta, sit, walk, 0, rig.motion.gestureAmount);
    const keys = typing && clip === 'none' && !reducedMotion;
    // Hand goals at the desk (wrist targets and IK strength), glided between clips.
    const goals = handGoals.current ??= { shown: createHandGoals(), target: createHandGoals() };
    writeHandGoals(goals.target, clip, time, 0, reach, rig.motion.gestureAmount, sit, walk, seatHeight);
    if (atFitness && sit > 0.95 && (clip === "cycle" || resourceId === FITNESS_BLUEPRINT.cableRow.id)) {
      for (const index of [0, 1] as const) {
        const goal = fitnessHandGoal(resourceId, index ? 1 : -1, equipment);
        if (goal) { goals.target.target[index] = goal; goals.target.weight[index] = 1; }
      }
    }
    blendHandGoals(goals.shown, goals.target, 1 - Math.exp(-Math.max(0, delta) * 5));
    const idle = 1 - walk;
    const sway = rig.motion.swayAmount;
    const shift = (pose.pelvisShift * sway * idle + stride.pelvisShift) / rig.scale[0];
    const pelvisRoll = pose.pelvisRoll * sway * idle + stride.pelvisRoll;
    if (torso.current) {
      torso.current.position.y = hip + (reducedMotion ? 0 : Math.sin(time * rig.motion.breathRate) * 0.003) + act.bob / rig.scale[1];
      torso.current.position.x = shift;
      torso.current.rotation.x = 0.035 * sit + 0.03 * walk + act.torsoPitch;
      torso.current.rotation.y = stride.torsoTwist + act.torsoYaw;
      torso.current.rotation.z = pelvisRoll + pose.torsoRoll * sway * idle;
      torso.current.updateMatrix();
    }
    // Torso frame inverse: the arms solve their hand goals in the torso's own coordinates.
    const toTorso = torso.current ? torsoInverse.copy(torso.current.matrix).invert() : null;
    if (head.current) {
      writeFacialPose(facialPose, rig.seed, expressionTimeSeconds(), resolveCharacterExpression(expressionId, expressionState, motion), reducedMotion);
      head.current.rotation.x = act.headPitch + facialPose.headPitch;
      head.current.rotation.y = facialPose.headYaw - stride.torsoTwist + act.headYaw;
      head.current.rotation.z = -pose.torsoRoll * sway * 0.5 * idle;
    }
    if (drape.current) { drape.current.position.set(shift, hip, 0); drape.current.rotation.set(thigh, 0, pelvisRoll); }
    // Props: the mug in the hand that lifts it, the phone held between both hands (hidden with reduced motion).
    const mugHand = goals.shown.mugHand;
    const mugOn = !reducedMotion && goals.shown.mug > 0.5;
    if (weightLeft.current) weightLeft.current.visible = !reducedMotion && (clip === 'lift' || clip === 'bench-curl');
    if (weightRight.current) weightRight.current.visible = !reducedMotion && (clip === 'lift' || clip === 'bench-curl');
    if (mugLeft.current) mugLeft.current.visible = mugOn && mugHand === 0;
    if (mugRight.current) mugRight.current.visible = mugOn && mugHand === 1;
    if (phone.current) phone.current.visible = !reducedMotion && goals.shown.phone > 0.5;
    for (let limb = 0; limb < 2; limb++) {
      const index = limb as 0 | 1, left = index === 0, side = left ? -1 : 1, phase = left ? 0 : Math.PI;
      const upper = left ? leftArm : rightArm, lower = left ? leftElbow : rightElbow, hand = left ? leftHand : rightHand;
      const leg = left ? leftLeg : rightLeg, knee = left ? leftKnee : rightKnee;
      const standingArm = pose.armSway * side * rig.motion.gestureAmount * idle + stride.arm[index];
      // This mesh's left limbs sit at -X, so outward abduction is a negative Z turn on the left.
      const baseX = -0.38 * sit + standingArm * (1 - sit) + act.arm[index];
      const baseZ = side * act.armOut[index];
      const baseElbow = -1.08 * sit + (-0.06 + stride.elbow) * (1 - sit) + act.elbow[index];
      const baseWrist = (keys ? Math.sin(time * 8 + phase) * 0.035 : 0) + act.wrist[index];
      let pitch = baseX, roll = baseZ, elbow = baseElbow, wrist = baseWrist;
      // A hand reaching for a chair or a door (movement) takes over from the desk goal of its arm.
      const reachArm = motion?.reach[index];
      let w = goals.shown.weight[index];
      let goal = goals.shown.target[index];
      if (reachArm && reachArm.weight > 1e-3) { w = mixReachGoal(goal, w, reachArm, reachGoal); goal = reachGoal; }
      if (w > 1e-3 && toTorso) {
        // Inverse kinematics: the wrist goal in the torso frame, relative to this shoulder.
        shoulderGoal.set(goal[0] / rig.scale[0], goal[1] / rig.scale[1], goal[2] / rig.scale[2]).applyMatrix4(toTorso);
        solveArm3D(shoulderGoal.x - side * p.shoulderWidth / 2, shoulderGoal.y - p.shoulderHeight, shoulderGoal.z,
          p.upperArmLength, p.forearmLength, armSolution);
        const turn = wristAngle(FINGERS, armSolution.pitch, armSolution.abduction, armSolution.elbow);
        pitch = baseX * (1 - w) + armSolution.pitch * w;
        roll = baseZ * (1 - w) + armSolution.abduction * w;
        elbow = baseElbow * (1 - w) + armSolution.elbow * w;
        wrist = baseWrist * (1 - w) + (turn + act.wrist[index]) * w;
      }
      if (upper.current) upper.current.rotation.set(pitch, 0, roll);
      if (lower.current) lower.current.rotation.set(elbow, 0, 0);
      if (hand.current) hand.current.rotation.set(wrist, 0, 0);
      if (w > 1e-3 && toTorso && (reachArm?.weight ?? 0) <= 1e-3) {
        solveArmPole([shoulderGoal.x - side * p.shoulderWidth / 2, shoulderGoal.y - p.shoulderHeight, shoulderGoal.z], p.upperArmLength, p.forearmLength, side, deskArm);
        upper.current?.quaternion.slerp(deskArm.upper, w);
        lower.current?.quaternion.slerp(deskArm.lower, w);
      }
      const palm = hand.current, parent = palm?.parent, seatRoot = body.current?.parent;
      if (palm && parent && seatRoot && w > 1e-3 && (reachArm?.weight ?? 0) <= 1e-3) {
        parent.updateWorldMatrix(true, false);
        const orientation = { parentWorld: parent.matrixWorld, rootWorld: seatRoot.matrixWorld,
          direction: goals.shown.direction[index], palm: goals.shown.palm[index], localFinger: PROCEDURAL_FINGER_AXIS };
        if (writeHandOrientation(handOrientation, orientation, handOrientationScratch)) {
          // Forearm roll leaves its -Y wrist offset fixed instead of twisting only the wrist.
          const twist = handPronationAngle(palm.quaternion, handOrientation, FOREARM_AXIS, handOrientationScratch);
          parent.quaternion.multiply(forearmPronation.setFromAxisAngle(FOREARM_AXIS, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, twist * .75)) * w));
          parent.updateWorldMatrix(true, false);
          writeHandOrientation(handOrientation, orientation, handOrientationScratch);
          palm.quaternion.slerp(handOrientation, w);
        }
      }
      const fingers = left ? leftFingers.current : rightFingers.current;
      for (let finger = 0; finger < fingers.length; finger++) {
        if (fingers[finger]) fingers[finger]!.rotation.x = .08 * (1 - w) + (goals.shown.curl[index][finger] ?? .18) * w;
      }
      const wantedThigh = thigh + stride.hip[index] + act.thigh[index];
      const legPitch = supportedThigh(wantedThigh, seatedLeg, sit);
      const legHip = hip + side * Math.sin(pelvisRoll) * p.hipWidth / 2;
      if (leg.current) {
        leg.current.position.set(side * p.hipWidth / 2 + shift, legHip, 0);
        leg.current.rotation.set(legPitch, 0, -shift / legLength);
      }
      const kneePitch = floorSeatedKnee(legPitch,
        -thigh + stride.knee[index] + act.knee[index] + wantedThigh - legPitch,
        legHip * rig.scale[1], p.thighLength * rig.scale[1], p.shinLength * rig.scale[1], -0.012 * rig.scale[1], sit);
      if (knee.current) knee.current.rotation.x = kneePitch;
      const foot = left ? leftFoot : rightFoot;
      if (foot.current) foot.current.rotation.x = -(legPitch + kneePitch) * sit;
      if (atFitness && sit > 0.95 && clip === "cycle" && leg.current && knee.current) {
        const goal = bikeFootGoal(side, equipment?.phase ?? 0, HUMANOID_LEG_RADIUS * rig.scale[1]);
        solveFitnessLeg([goal[0] / rig.scale[0] - side * p.hipWidth / 2 - shift,
          goal[1] / rig.scale[1] - legHip, goal[2] / rig.scale[2]], p.thighLength, p.shinLength, fitnessLeg);
        leg.current.quaternion.copy(fitnessLeg.upper); knee.current.quaternion.copy(fitnessLeg.lower);
        if (foot.current) foot.current.quaternion.copy(fitnessFoot.copy(fitnessLeg.upper).multiply(fitnessLeg.lower).invert());
      }
    }
    for (const [index, cup] of [[0, mugLeft.current], [1, mugRight.current]] as const) {
      const hand = index === 0 ? leftHand.current : rightHand.current, seatRoot = body.current?.parent;
      if (cup && hand && seatRoot) {
        hand.updateWorldMatrix(true, false);
        shoulderGoal.setFromMatrixPosition(hand.matrixWorld).applyMatrix4(torsoInverse.copy(seatRoot.matrixWorld).invert());
        cup.position.set(shoulderGoal.x + (index === 0 ? .045 : -.045), shoulderGoal.y + .015, shoulderGoal.z + .045);
        const weight = index === 0 ? weightLeft.current : weightRight.current;
        if (weight) weight.position.set(shoulderGoal.x, shoulderGoal.y, shoulderGoal.z + .04);
      }
    }
  });
  return <group ref={body} scale={[...rig.scale]}>
    <group ref={torso} position={[0, p.standingHipHeight, 0]}>
      <GarmentTorso proportions={p} wardrobe={wardrobe} skin={skin} seated={seated} />
      {skirt && <SkirtYoke proportions={p} wardrobe={wardrobe} />}
      <group ref={head} position={[0, p.headHeight, 0]} scale={presentationPreset(visual.presentation) === 'feminine' ? [0.94, HUMANOID_HEAD_ELONGATION, 1] : [1, HUMANOID_HEAD_ELONGATION, 1.04]}>
        <mesh castShadow><sphereGeometry args={[p.headRadius, 16, 12]} /><meshStandardMaterial color={skin} roughness={0.87} /></mesh>
        <HairStyle variant={visual.hairVariant} color={hair} radius={p.headRadius} skin={skin} />
        {visual.accessories?.earrings && <Earrings style={visual.accessories.earrings} radius={p.headRadius} />}
        <HumanoidFace radius={p.headRadius} skin={skin} hair={hair} seed={rig.seed} accessories={visual.accessories} reducedMotion={reducedMotion}
          expressionId={expressionId} expressionState={expressionState} motion={motion} />
      </group>
      {([-1, 1] as const).map(side => <Limb key={side} pivot={[side * p.shoulderWidth / 2, p.shoulderHeight, 0]}
        upperLength={p.upperArmLength} lowerLength={p.forearmLength} radius={HUMANOID_ARM_RADIUS} upperColor={sleeve}
        lowerColor={wardrobe.sleeve === 'long' ? sleeve : skin} fabric={wardrobe.sleeve === 'long'}
        upperTrim={wardrobe.sleeve === 'rolled' ? <SleeveCuff length={p.upperArmLength} radius={HUMANOID_ARM_RADIUS + 0.01} color={wardrobe.top} rolled /> : undefined}
        lowerTrim={wardrobe.sleeve === 'long' ? <SleeveCuff length={p.forearmLength} radius={HUMANOID_ARM_RADIUS} color={wardrobe.top} rolled={false} /> : undefined}
        upperRef={side === -1 ? leftArm : rightArm} lowerRef={side === -1 ? leftElbow : rightElbow}>
        <Hand handRef={side === -1 ? leftHand : rightHand} fingerRefs={side === -1 ? leftFingers : rightFingers} skin={skin} watch={side === -1 ? watch : undefined} thumbSide={-side}>
          {/* Carried while standing; set beside the seat when seated. */}
          {side === 1 && bag && !seated && <group position={[0, -0.33, 0]} rotation={[0, Math.PI / 2, 0]}><Bag style={bag} /></group>}
        </Hand>
      </Limb>)}
      <GarmentDetails proportions={p} wardrobe={wardrobe} badge={visual.accessories?.badge} skin={skin} seated={seated} />
    </group>
    {skirt && <SkirtDrape proportions={p} wardrobe={wardrobe} drapeRef={drape} />}
    <group scale={invScale}><DumbbellProp groupRef={weightLeft} /><DumbbellProp groupRef={weightRight} /><MugProp groupRef={mugLeft} /><MugProp groupRef={mugRight} /><HospitalityProps motion={motion} goals={handGoals} reducedMotion={reducedMotion} /></group>
    {/* The phone, held at chest height between both hands (metres, undoing the body's scale). */}
    <group position={[PHONE_CENTRE[0] / rig.scale[0], PHONE_CENTRE[1] / rig.scale[1], PHONE_CENTRE[2] / rig.scale[2]]} scale={invScale}>
      <PhoneProp groupRef={phone} />
    </group>
    {([-1, 1] as const).map(side => <Limb key={side} pivot={[side * p.hipWidth / 2, p.standingHipHeight, 0]} upperLength={p.thighLength} lowerLength={p.shinLength} radius={HUMANOID_LEG_RADIUS}
      upperColor={skirt ? skin : wardrobe.bottom} lowerColor={skirt ? skin : wardrobe.bottom} fabric={!skirt}
      upperRef={side === -1 ? leftLeg : rightLeg} lowerRef={side === -1 ? leftKnee : rightKnee}><group ref={side === -1 ? leftFoot : rightFoot}><DetailedShoe wardrobe={wardrobe} /></group></Limb>)}
    {bag && seated && <group position={[0.46, 0, -0.04]} rotation={[0, -Math.PI / 2 + 0.25, 0]}><Bag style={bag} /></group>}
  </group>;
}

/**
 * The humanoid body alone (local source model when present, procedural otherwise),
 * shared by agent characters and facility staff.
 */
export function CharacterBody({ id, appearance, presentation, seated, typing, seatHeight, seatFront, reducedMotion, motion, desk, resourceId, expressionId, expressionState }: {
  /** Seeds the rig, palette and generated look: a presence id, or a name seed (v0.0.30). */
  id: string; appearance?: CharacterAppearance | undefined;
  /** Explicit presentation of a generated look (from gender metadata). */
  presentation?: CharacterPresentation | undefined;
  seated: boolean; typing: boolean; seatHeight?: number | undefined; seatFront?: number | undefined;
  resourceId?: string | undefined; reducedMotion: boolean; motion?: CharacterMotion | undefined; desk?: DeskReach | undefined;
  expressionId?: string | undefined; expressionState?: CharacterExpressionState | undefined;
}) {
  const visual = useMemo(() => appearance ? avatarVisual(id, appearance) : characterAppearance(id, presentation), [id, appearance, presentation]);
  const sourceUrls = useMemo(() => sourceAvatarUrls(visual, sourceHairAsset(visual)), [visual]);
  useEffect(() => {
    if (!sourceUrls) return;
    // Start hair alongside the body rather than after its suspended read.
    // Keep per-URL caches: different hairstyles still share the same body asset.
    useGLTF.preload(sourceUrls.body, false, false);
    useGLTF.preload(sourceUrls.hair, false, false);
    if (sourceUrls.outfit) useGLTF.preload(sourceUrls.outfit, false, false);
    for (const url of Object.values(sourceUrls.parts ?? {})) if (url) useGLTF.preload(url, false, false);
  }, [sourceUrls]);
  const fallback = <CharacterMesh visual={visual} seated={seated} typing={typing} seatHeight={seatHeight} seatFront={seatFront} reducedMotion={reducedMotion} motion={motion} desk={desk} resourceId={resourceId} expressionId={expressionId} expressionState={expressionState} />;
  // Show one body style: wait for selected source assets; use the procedural
  // character only when sources are absent or fail, not as a loading placeholder.
  return sourceUrls
    ? <SourceAvatarBoundary key={`${sourceUrls.body}|${sourceUrls.hair}|${sourceUrls.outfit ?? ''}|${JSON.stringify(sourceUrls.parts)}`} fallback={fallback}>
      <Suspense fallback={null}>
        <SourcePieceAssets urls={sourceUrls.parts}>{pieces => <SourceHumanoid pieces={pieces} visual={visual} urls={sourceUrls} seated={seated} typing={typing} reducedMotion={reducedMotion} seatHeight={seatHeight} seatFront={seatFront} motion={motion} desk={desk} resourceId={resourceId} expressionId={expressionId} expressionState={expressionState} />}</SourcePieceAssets>
      </Suspense>
    </SourceAvatarBoundary>
    : fallback;
}

/** Visual-only presence: animation never creates or infers a runtime task state. */
export function OfficeCharacter({ agent, position, rotationY = 0, seated = false, seatHeight, seatFront, onSelect, reducedMotion = false, appearance, motion, desk, resourceId, onHoverStart, onHoverEnd }: OfficeCharacterProps) {
  // Managed agents report running through the host; observed ones only while their own recent events say so.
  const typing = seated && (agent.control === 'managed' || Boolean(agent.live)) && agent.running && agent.status === 'working';
  const expressionState = expressionStateForAgent(agent);
  useEffect(() => bindCharacterExpression(agent.id, { state: expressionState, motion }), [agent.id, expressionState, motion]);
  const pick = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(agent.id); };
  return <group position={position} rotation={[0, rotationY, 0]} onClick={pick}>
    <CharacterBody id={lookSeed(agent.id, agent.look)} appearance={appearance} presentation={agent.look?.presentation} seated={seated} typing={typing} seatHeight={seatHeight} seatFront={seatFront} reducedMotion={reducedMotion} motion={motion} desk={desk} resourceId={resourceId} expressionId={agent.id} expressionState={expressionState} />
    {/* Invisible pick volume: clicks select, and R3F's own pointer raycast reveals the tag on hover (frontmost character only). */}
    <mesh position={[0, seated ? 0.7 : 0.9, seated ? 0.16 : 0]}
      onPointerOver={onHoverStart && (event => { event.stopPropagation(); onHoverStart(); })}
      onPointerOut={onHoverEnd && (() => onHoverEnd())}>
      <boxGeometry args={[1.1, seated ? 1.5 : 1.9, 1.1]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  </group>;
}
