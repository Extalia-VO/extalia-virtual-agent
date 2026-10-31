 
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import type { Group, Material, Mesh, Object3D } from 'three';
import { Bone, Color, Euler, Matrix4, MeshStandardMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { resolveWardrobe, officeGarmentVisibility, OFFICE_WARDROBE_MESHES, SOURCE_WARDROBE_MESHES } from './AvatarWardrobe';
import { SCAN_OUTFIT_MODEL, scanAccessorySlots, scanOutfitSlot } from './wardrobe';
import { presentationPreset, type AvatarVisualConfig } from './appearance';
import { createHumanoidRigProfile } from './rig';
import { gaitParameters, idlePose } from './gait';
import { createWalkPose, writeWalkPose, type CharacterMotion } from '../movement/walkCycle';
import { createClipDriver, stepClipDriver } from './activityPose';
import { createSeatedLegPose, floorSeatedKnee, seatedLegPose, supportedThigh } from './seatedPose';
import { createArmPoleSolution, solveArmPole } from './armPole';
import { solveArm3D, wristAngle, type Arm3DSolution } from './armIk';
import { createSourceArmRotations, sourceArmGoalFrame, sourceAvatarScale, sourceLimbBasis, writeSourceArmRotations } from './sourceArmBasis';
import { deskReachForSeat, type DeskReach } from './deskReach';
import { createHandOrientationScratch, handPronationAngle, writeHandOrientation } from './handOrientation';
import { sourceLimbWeights } from './sourceLimbWeights';
import { sourceGarmentWeights } from './sourceGarmentWeights';
import { applySeatedDrape, copyFittedMorphTargets, seatedDrapeBindings } from './sourceSeatedDrape';
import { applyWalkDrape, walkDrapeBindings } from './sourceWalkDrape';
import { fitSourceFootGeometry } from './sourceFootGeometry';
import { isCanonicalSourceHandAsset, attachSourceHandCurl, sourceHandCurlInfluence, sourceHandCurlLengths } from './sourceHandCurl';
import { mixReachGoal } from './reachPose';
import { blendHandGoals, createHandGoals, PHONE_CENTRE, resolveDeskHandClip, writeHandGoals, type HandGoals } from './handGoals';
import { DumbbellProp, MugProp, PhoneProp } from './IdleProps';
import { bikeFootGoal, createFitnessLegSolution, fitnessHandGoal, fitnessMechanism, solveFitnessLeg } from "../interior/fitnessMechanics";
import { FITNESS_BLUEPRINT } from "../interior/spatialBlueprints";
import { HospitalityProps } from './HospitalityProps';
import type { SourceAvatarUrls } from './sourceAssets';
import type { SourcePieceScenes } from './SourcePieceAssets';
import { sourceWardrobeGeometry, wardrobeReplacementParts } from './sourceWardrobeGeometry';
import { tintOriginalGarmentMaterial } from './sourceOriginalMaterials';
import { attachWardrobePieces, wardrobePieceHasFootwear } from './sourceWardrobePieces';
import { declaredWardrobeCoverage, underlayerCoverageGeometry } from './sourceWardrobeCoverage';
import { footwearFloorContact, nativeFootwearGeometry, sourceFootwearProfiles, wardrobeFootSoleProfile } from './sourceNativeFootwear';
import { resolvedOriginalSetFeatures } from './sourceOriginalSetFeatures';
import { nativeBodyWithoutHands } from './sourceOwnHandsGeometry';
import { sourceUnderlayerFit } from './sourceUnderlayerFit';
import { applyShoulderCorrectives, shoulderCorrectiveBindings } from './sourceShoulderCorrective';
import { sourceWaistBacking } from './sourceWaistBacking';
import { createLodState, lodStep, lodTier, screenHeightPixels, setCastShadows, widenSkinnedBounds } from './avatarLod';
import { createFacialPose, expressionTimeSeconds, resolveCharacterExpression, writeFacialPose, type CharacterExpressionState } from './facialExpression';
import { attachSourceFaceExpressions, writeSourceFaceExpressions, type SourceFaceBinding } from './sourceFaceExpressions';

/**
 * Local source-derived GLB geometry, wardrobe slots and skeletal coordinate system. Only mounted
 * when `sourceAvatarUrls` found both models in the git-ignored local asset folder.
 */
/** Scratch shared by every character (the solve and the torso transform run synchronously within a frame). */
const armSolution: Arm3DSolution = { pitch: 0, elbow: 0, abduction: 0, error: 0 };
const deskArm = createArmPoleSolution();
const deskUpper = new Quaternion(), deskLower = new Quaternion(), deskBasisInverse = new Quaternion();
const torsoInverse = new Matrix4();
const goalPoint = new Vector3();
const reachGoal: [number, number, number] = [0, 0, 0];
const handOrientation = new Quaternion(), forearmPronation = new Quaternion();
const forearmAxis = new Vector3();
const SOURCE_FINGER_AXIS = [0, 1, 0] as const;
/** Fingers point across the keyboard with a slight downward angle. */
const FINGERS: [number, number, number] = [0, -0.14, 1];

/** Body materials drawn as strand cards (facial hair, brows, lashes). */
const LINING_GREY = new Color('#b8b6b2');
const STRAND_CARD_MATERIAL = /^(Beard|Mustache|Eyebrow|Eyelash)/;

/** Strand alpha below this is cut away (hair cards). */
const HAIR_CARD_CUTOFF = 0.4;

/**
 * Hair cards draw as cut-outs, not blended: blended cards are not sorted against each other or
 * the head, so whole layers vanished from some angles. Detailed hair exports carry a blended
 * strand texture; light hair meshes have no texture and stay as they are.
 */
function cutOutHairCards(material: Material): void {
  if (!(material instanceof MeshStandardMaterial) || !material.map || !material.transparent) return;
  material.transparent = false;
  material.alphaTest = HAIR_CARD_CUTOFF;
  material.depthWrite = true;
  material.needsUpdate = true;
}

/**
 * Attach a fitted outfit model (`avatars/outfits/...`: the 20-joint rig plus one skinned mesh) to
 * a cloned body: each skinned mesh is rebound to the body's own bones by name, keeps its bind
 * pose, and joins the outfit slots as `ScanOutfitModel`. Materials are per-instance copies.
 */
function attachOutfitModel(body: Group, outfit: Group, name = SCAN_OUTFIT_MODEL): number {
  const bones = new Map<string, Bone>();
  let scan: SkinnedMesh | undefined;
  body.traverse(child => {
    if (child instanceof Bone) bones.set(child.name, child);
    if (!scan && (child as SkinnedMesh).isSkinnedMesh && child.name.replace(/_\d+$/, '').startsWith('ScanOutfit')) scan = child as SkinnedMesh;
  });
  // The outfit shares the body's rig and export frame: bind it exactly like the scanned outfit.
  const host: Object3D | undefined = scan?.parent ?? undefined;
  const meshes: SkinnedMesh[] = [];
  outfit.traverse(child => { if ((child as SkinnedMesh).isSkinnedMesh) meshes.push(child as SkinnedMesh); });
  if (!host || meshes.some(source => source.skeleton.bones.some(bone => !bones.has(bone.name)))) return 0;
  let attached = 0;
  for (const source of meshes) {
    const joints = source.skeleton.bones.map(bone => bones.get(bone.name));
    if (!host || joints.some(bone => !bone)) continue;
    const mesh = new SkinnedMesh(source.geometry, Array.isArray(source.material) ? source.material.map(material => material.clone()) : source.material.clone());
    copyFittedMorphTargets(source, mesh);
    mesh.name = name;
    mesh.bind(new Skeleton(joints as Bone[], source.skeleton.boneInverses.map(matrix => matrix.clone())), (scan ?? source).bindMatrix.clone());
    mesh.castShadow = mesh.receiveShadow = true;
    host.add(mesh);
    attached++;
  }
  return attached;
}

export function SourceHumanoid({ visual, urls, pieces, seated, typing, reducedMotion, seatHeight = 0.46, seatFront = 0.22, motion, desk, resourceId, expressionId, expressionState }: {
  visual: AvatarVisualConfig; urls: SourceAvatarUrls; pieces?: SourcePieceScenes; seated: boolean; typing: boolean; reducedMotion: boolean; seatHeight?: number; seatFront?: number;
  resourceId?: string | undefined;
  expressionId?: string | undefined;
  expressionState?: CharacterExpressionState | undefined;
  /** Live walk/sit blend from the movement layer. */
  motion?: CharacterMotion | undefined;
  /** Desk the character sits at (the single desk without one). */
  desk?: DeskReach | undefined;
}) {
  const female = presentationPreset(visual.presentation) === 'feminine';
  // Source packs are uncompressed: avoid Draco network downloads and an unused WebAssembly decoder.
  const gltf = useGLTF(urls.body, false, false);
  const hairGltf = useGLTF(urls.hair, false, false);
  // Without a fitted outfit model this reads the (already cached) body again and is ignored.
  const outfitGltf = useGLTF(urls.outfit ?? urls.body, false, false);
  const hairModel = useMemo(() => {
    const scene = clone(hairGltf.scene) as Group;
    const bones = new Map<string, Bone>();
    scene.traverse(child => {
      if (child instanceof Bone) bones.set(child.name, child);
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material => material.clone()) : mesh.material.clone();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) cutOutHairCards(material);
      mesh.castShadow = mesh.receiveShadow = true;
    });
    scene.updateMatrixWorld(true);
    widenSkinnedBounds(scene);
    return { scene, bones };
  }, [hairGltf.scene]);
  useEffect(() => () => hairModel.scene.traverse(child => {
    const mesh = child as Mesh;
    if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }), [hairModel]);
  useEffect(() => {
    hairModel.scene.traverse(child => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.morphTargetDictionary?.Female !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[mesh.morphTargetDictionary.Female] = female ? 1 : 0;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material instanceof MeshStandardMaterial) material.color.set(visual.hairColor ?? '#302b2c');
      }
    });
  }, [hairModel, female, visual.hairColor]);
  const topPiece = pieces?.top, bottomPiece = pieces?.bottom, outerPiece = pieces?.outer;
  const mixing = visual.clothing?.parts !== undefined, selectedOuter = visual.clothing?.parts?.outer;
  const model = useMemo(() => {
    const scene = clone(gltf.scene) as Group;
    scene.traverse(child => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material => material.clone()) : mesh.material.clone();
      // Facial hair, brows and lashes are strand cards too.
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (STRAND_CARD_MATERIAL.test(material.name)) cutOutHairCards(material);
      mesh.castShadow = mesh.receiveShadow = true;
    });
    const fittedOutfit = urls.outfit ? attachOutfitModel(scene, outfitGltf.scene) > 0 : false;
    const loadedParts = attachWardrobePieces({
      ...(topPiece ? { top: topPiece } : {}),
      ...(bottomPiece ? { bottom: bottomPiece } : {}),
      ...(outerPiece ? { outer: outerPiece } : {}),
    }, (slot, piece) => attachOutfitModel(scene, piece, `WardrobePiece${slot[0]!.toUpperCase()}${slot.slice(1)}`) > 0);
    const originalFeatures = resolvedOriginalSetFeatures(fittedOutfit ? outfitGltf.scene : undefined, {
      ...(topPiece ? { top: topPiece } : {}), ...(outerPiece ? { outer: outerPiece } : {}),
    }, loadedParts);
    const replacements = wardrobeReplacementParts({
      ...loadedParts,
      ...(loadedParts.bottom && bottomPiece ? { footwear: wardrobePieceHasFootwear(bottomPiece) } : {}),
    }, mixing, selectedOuter);
    scene.updateMatrixWorld(true);
    widenSkinnedBounds(scene);
    const inverse = scene.getWorldQuaternion(new Quaternion()).invert();
    const bones = new Map<string, { bone: Bone; rest: Quaternion; world: Quaternion }>();
    scene.traverse(child => { if (child instanceof Bone) bones.set(child.name, { bone: child, rest: child.quaternion.clone(), world: inverse.clone().multiply(child.getWorldQuaternion(new Quaternion())) }); });
    const handCurls: { mesh: SkinnedMesh; targets: readonly [number, number] }[] = [];
    const curlMeshes: SkinnedMesh[] = [];
    scene.traverse(child => { if ((child as SkinnedMesh).isSkinnedMesh) curlMeshes.push(child as SkinnedMesh); });
    // Resolve isolated garment parts before the pure upper/lower hinge cleanup:
    // inner sleeve cloth can carry misplaced torso weights near the waist.
    // Raw assets and unrelated skin stay shared.
    if (isCanonicalSourceHandAsset(urls.body)) for (const mesh of curlMeshes) {
      const sleeve = sourceGarmentWeights(mesh);
      if (sleeve) mesh.geometry = sleeve;
      // Original sets include separately exported skin/context primitives too.
      // Keep their shared, reviewed binding rather than repairing each primitive.
      const corrected = sourceLimbWeights(mesh,
        fittedOutfit && originalFeatures.ownNeckline && mesh.name === SCAN_OUTFIT_MODEL);
      if (corrected) mesh.geometry = corrected;
    }
    const feet = isCanonicalSourceHandAsset(urls.body) ? fitSourceFootGeometry(curlMeshes) : undefined;
    for (const correction of feet?.corrections ?? []) correction.mesh.geometry = correction.geometry;
    // Full original sets can reuse the native feet AFTER the canonical correction above.
    // Their own exposed-leg skin overlaps these ankle pieces while the original garment stays intact.
    let nativeFootwear = false;
    if (originalFeatures?.nativeFootwear) {
      const additions: SkinnedMesh[] = [];
      for (const source of curlMeshes) {
        if (source.name.replace(/_\d+$/, '') !== 'ScanOutfit' || !source.parent) continue;
        const geometry = nativeFootwearGeometry(source);
        if (!geometry) continue;
        const mesh = new SkinnedMesh(geometry, Array.isArray(source.material) ? source.material.map(material => material.clone()) : source.material.clone());
        mesh.name = 'WardrobeNativeFootwear';
        mesh.position.copy(source.position); mesh.quaternion.copy(source.quaternion); mesh.scale.copy(source.scale);
        mesh.matrix.copy(source.matrix); mesh.matrixAutoUpdate = source.matrixAutoUpdate;
        mesh.bind(source.skeleton, source.bindMatrix.clone());
        mesh.castShadow = mesh.receiveShadow = true;
        source.parent.add(mesh);
        additions.push(mesh);
      }
      nativeFootwear = additions.length > 0;
      curlMeshes.push(...additions);
      widenSkinnedBounds(scene);
    }
    if (mixing) for (const mesh of curlMeshes) {
      if (mesh.name.replace(/_\d+$/, '').startsWith('ScanOutfit')) mesh.geometry = sourceWardrobeGeometry(mesh, replacements);
    }
    const coverage = loadedParts.outer && outerPiece ? declaredWardrobeCoverage(outerPiece) : undefined;
    if (coverage) for (const mesh of curlMeshes) {
      const name = mesh.name.replace(/_\d+$/, '');
      if (name.startsWith('ScanOutfit') || name === 'WardrobePieceTop' || name === 'BodyNeckline') {
        mesh.geometry = underlayerCoverageGeometry(mesh, coverage);
      }
    }
    if (originalFeatures.ownHands) for (const mesh of curlMeshes) {
      mesh.geometry = nativeBodyWithoutHands(mesh, true);
    }
    const upperLayers = curlMeshes.filter(mesh => fittedOutfit && mesh.name === SCAN_OUTFIT_MODEL
      || loadedParts.top && mesh.name === 'WardrobePieceTop' || loadedParts.outer && mesh.name === 'WardrobePieceOuter');
    if (upperLayers.length) {
      for (const mesh of curlMeshes) mesh.geometry = sourceUnderlayerFit(mesh, upperLayers);
      widenSkinnedBounds(scene);
    }
    const bottomLayer = loadedParts.bottom && curlMeshes.find(mesh => mesh.name === 'WardrobePieceBottom');
    if (bottomLayer) {
      for (const mesh of curlMeshes) mesh.geometry = sourceWaistBacking(mesh, bottomLayer);
      widenSkinnedBounds(scene);
    }
    const { profiles: footSoles, slot: footwearSlot } = sourceFootwearProfiles(feet?.soleByOutfit, curlMeshes, {
      fullOutfit: fittedOutfit && !originalFeatures.nativeFootwear,
      bottom: loadedParts.bottom === true && replacements.footwear === true,
    });
    const curlLengths = sourceHandCurlLengths(curlMeshes);
    const faces: SourceFaceBinding[] = [];
    for (const mesh of curlMeshes) {
      const curl = attachSourceHandCurl(mesh, urls.body, curlLengths);
      if (curl) handCurls.push({ mesh, targets: curl.targets });
      const face = attachSourceFaceExpressions(mesh, urls.body);
      if (face) faces.push(face);
    }
    return { scene, bones, handCurls, faces, seatedDrapes: seatedDrapeBindings(curlMeshes), walkDrapes: walkDrapeBindings(curlMeshes), shoulderCorrectives: shoulderCorrectiveBindings(curlMeshes, bones), standingHip: bones.get('hips')?.bone.position.y ?? 1.0064, footSoles, footwearSlot, nativeFootwear, ownNeckline: originalFeatures?.ownNeckline === true, ownEyewear: originalFeatures.ownEyewear === true,
      slots: new Set(curlMeshes.map(mesh => mesh.name.replace(/_\d+$/, ''))) };
  }, [gltf.scene, urls.body, urls.outfit, outfitGltf.scene, topPiece, bottomPiece, outerPiece, mixing, selectedOuter]);
  useEffect(() => () => model.scene.traverse(child => {
    const mesh = child as Mesh;
    if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }), [model]);
  const rig = useMemo(() => createHumanoidRigProfile(visual.identityId, { stature: visual.stature }), [visual.identityId, visual.stature]);
  const wardrobe = useMemo(() => resolveWardrobe(visual, rig.seed), [visual, rig.seed]);
  const footSoles = wardrobeFootSoleProfile(model.footSoles, model.footwearSlot ?? scanOutfitSlot(wardrobe.outfit, model.slots, visual.clothing?.model), model.nativeFootwear);
  const { standingOffset: standingSoleLift, soleByFoot: floorSoles } = useMemo(() => footwearFloorContact(footSoles), [footSoles]);
  const scale = (visual.heightMeters ?? 1.70) / 1.85;
  useEffect(() => {
    const slots = new Set<string>();
    let sourceFaceComplete = false;
    model.scene.traverse(child => { if ((child as Mesh).isMesh) slots.add(child.name.replace(/_\d+$/, '')); });
    model.scene.traverse(child => { if (child.name.replace(/_\d+$/, '') === 'Body' && child.userData.sourceFaceComplete === true) sourceFaceComplete = true; });
    const clothes = officeGarmentVisibility(wardrobe, slots.has('SourceTop'));
    const scanOutfit = scanOutfitSlot(wardrobe.outfit, slots, visual.clothing?.model);
    const accessories = scanAccessorySlots(visual.accessories, scanOutfit, visual.clothing?.model);
    if (model.ownEyewear) accessories.delete('AccGlasses');
    model.scene.traverse(child => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const name = mesh.name.replace(/_\d+$/, '');
      if (name.startsWith('Hair_')) mesh.visible = false;
      else if (name === 'Eyes' || name === 'Eyebrows') mesh.visible = !sourceFaceComplete;
      else if (name === 'BodyNeckline' && model.ownNeckline) mesh.visible = false;
      else if (name.startsWith('Facial')) mesh.visible = !female && Boolean(visual.accessories?.custom?.some(style => name.toLowerCase().includes(style)));
      else if (OFFICE_WARDROBE_MESHES.has(name) || SOURCE_WARDROBE_MESHES.has(name)) mesh.visible = clothes.has(name);
      else if (name.startsWith('ScanOutfit')) mesh.visible = name === scanOutfit;
      else if (name.startsWith('Acc')) mesh.visible = accessories.has(name);
      if (mesh.morphTargetDictionary?.Female !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[mesh.morphTargetDictionary.Female] = female ? 1 : 0;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!(material instanceof MeshStandardMaterial)) continue;
        if (tintOriginalGarmentMaterial(material, visual.clothing)) continue;
        const materialName = material.name;
        if (materialName.startsWith('Skin_') || materialName.startsWith('Nails')) material.color.set(visual.skinTone ?? '#bf9278');
        else if (/OfficeHair|Eyebrow|Beard|Mustache/.test(materialName)) material.color.set(visual.hairColor ?? '#302b2c');
        else if (materialName.startsWith('OfficeTop')) material.color.set(wardrobe.top);
        else if (materialName.startsWith('OfficeOuter')) material.color.set(wardrobe.jacket);
        else if (materialName.startsWith('OfficeAccent')) material.color.set(wardrobe.accent);
        else if (materialName.startsWith('OfficeTrim')) material.color.set(wardrobe.trim);
        // The satin back of a vest: the jacket colour, lifted toward grey.
        else if (materialName.startsWith('OfficeLining')) material.color.set(wardrobe.jacket).lerp(LINING_GREY, 0.45);
        else if (materialName.startsWith('OfficeBottom')) material.color.set(wardrobe.bottom);
        else if (materialName.startsWith('OfficeShoes')) material.color.set(wardrobe.shoes);
      }
    });
  }, [model, visual, wardrobe, female]);
  // Arm geometry at rest, in model units: the shoulder offset from the hips and the two limb lengths, per geometric side.
  // Index 0 is the −X limb, matching the procedural character and the hand goals. The order comes from the bones'
  // rest positions, not their names: these +Z-facing assets label +X "right",
  // but anatomical right is −X (forward cross up), hand-goal index 0.
  const arms = useMemo(() => {
    model.scene.updateMatrixWorld(true);
    const at = (name: string) => model.bones.get(name)?.bone;
    const hips = at('hips')?.getWorldPosition(new Vector3()) ?? new Vector3();
    const geometry = (names: readonly [string, string, string]) => {
      const upper = at(names[0])?.getWorldPosition(new Vector3()) ?? new Vector3();
      const lower = at(names[1])?.getWorldPosition(new Vector3()) ?? new Vector3();
      const hand = at(names[2])?.getWorldPosition(new Vector3()) ?? new Vector3();
      return { names, hand: at(names[2]), shoulder: upper.clone().sub(hips), upper: upper.distanceTo(lower), lower: lower.distanceTo(hand),
        upperBasis: sourceLimbBasis(lower.clone().sub(upper)), lowerBasis: sourceLimbBasis(hand.clone().sub(lower)) };
    };
    const right = geometry(['rightUpperArm', 'rightLowerArm', 'rightHand']);
    const left = geometry(['leftUpperArm', 'leftLowerArm', 'leftHand']);
    return right.shoulder.x <= left.shoulder.x ? [right, left] as const : [left, right] as const;
  }, [model]);
  const restChestFromHip = useMemo(() => {
    model.scene.updateMatrixWorld(true);
    const hips = model.bones.get('hips')?.bone.getWorldPosition(new Vector3()) ?? new Vector3();
    const chest = model.bones.get('chest')?.bone;
    return new Matrix4().makeTranslation(-hips.x, -hips.y, -hips.z)
      .multiply(chest?.matrixWorld ?? new Matrix4());
  }, [model]);
  const legs = useMemo(() => {
    model.scene.updateMatrixWorld(true);
    const hips = model.bones.get('hips')?.bone.getWorldPosition(new Vector3()) ?? new Vector3();
    return (['left', 'right'] as const).map(side => {
      const names = [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`] as const;
      const point = (name: string) => model.bones.get(name)?.bone.getWorldPosition(new Vector3()) ?? new Vector3();
      const upper = point(names[0]), lower = point(names[1]), foot = point(names[2]);
      return { names, offsetX: upper.x - hips.x, offsetZ: upper.z - hips.z, offsetY: upper.y - hips.y, upper: upper.distanceTo(lower), lower: lower.distanceTo(foot), ankle: foot.y,
        upperBasis: sourceLimbBasis(lower.clone().sub(upper)), lowerBasis: sourceLimbBasis(foot.clone().sub(lower)) };
    });
  }, [model]);
  const legRotations = useMemo(() => createSourceArmRotations(), []);
  const fitnessLeg = useMemo(() => createFitnessLegSolution(), []);
  const fitnessRotation = useMemo(() => new Quaternion(), []);
  const fitnessInverse = useMemo(() => new Quaternion(), []);
  const footRotation = useMemo(() => new Quaternion(), []);
  const legPose = useMemo(() => createSeatedLegPose(), []);
  const gScale = sourceAvatarScale(visual.heightMeters ?? 1.70, rig.scale);
  const invScale: [number, number, number] = [1 / gScale[0], 1 / gScale[1], 1 / gScale[2]];
  const reach = desk ?? deskReachForSeat(undefined);
  const goalsRef = useRef<{ shown: HandGoals; target: HandGoals } | null>(null);
  const mugLeft = useRef<Group>(null), mugRight = useRef<Group>(null);
  const weightLeft = useRef<Group>(null), weightRight = useRef<Group>(null);
  const phoneRef = useRef<Group>(null);
  const rotation = useMemo(() => ({ euler: new Euler(), delta: new Quaternion(), local: new Quaternion() }), []);
  const armRotations = useMemo(() => createSourceArmRotations(), []);
  const handOrientationScratch = useMemo(() => createHandOrientationScratch(), []);
  const forearmRoll = useRef<[number, number]>([0, 0]);
  const gait = useMemo(() => gaitParameters({ gait: visual.gait, heightCm: visual.heightMeters === undefined ? undefined : visual.heightMeters * 100 }), [visual.gait, visual.heightMeters]);
  const walkPose = useMemo(() => createWalkPose(), []);
  const facePose = useMemo(() => createFacialPose(), []);
  const clipDriver = useMemo(() => createClipDriver(), []);
  const rotate = useMemo(() => (name: string, x: number, y = 0, z = 0) => {
    const entry = model.bones.get(name);
    if (!entry) return;
    rotation.delta.setFromEuler(rotation.euler.set(x, y, z, 'YXZ'));
    rotation.local.copy(entry.world).invert().multiply(rotation.delta).multiply(entry.world);
    entry.bone.quaternion.copy(entry.rest).multiply(rotation.local);
  }, [model, rotation]);
  const rotateDelta = useMemo(() => (name: string, delta: Quaternion) => {
    const entry = model.bones.get(name);
    if (!entry) return;
    rotation.local.copy(entry.world).invert().multiply(delta).multiply(entry.world);
    entry.bone.quaternion.copy(entry.rest).multiply(rotation.local);
  }, [model, rotation]);
  // Level of detail of this same model: small on screen, it poses less often and drops its shadow.
  const lod = useMemo(() => createLodState(), []);
  const lodRoot = useRef<Group>(null);
  useFrame(({ clock, camera, size }, frameDelta) => {
    let delta = frameDelta;
    if (lodRoot.current) {
      const tier = lodTier(screenHeightPixels(lodRoot.current, camera, size.height), lod.tier);
      if ((tier === 2) !== (lod.tier === 2)) { setCastShadows(model.scene, tier < 2); setCastShadows(hairModel.scene, tier < 2); }
      const step = lodStep(lod, tier, frameDelta);
      if (step === null) return;
      delta = step;
    }
    const time = reducedMotion ? 0 : clock.elapsedTime;
    writeFacialPose(facePose, rig.seed, expressionTimeSeconds(), resolveCharacterExpression(expressionId, expressionState ?? (typing ? 'focused' : 'idle'), motion), reducedMotion);
    writeSourceFaceExpressions(model.faces, facePose);
    // `sit` blends standing and seated poses; the walk cycle comes from the same gait as the procedural character.
    const sit = motion ? motion.sit : seated ? 1 : 0;
    const walk = motion && !reducedMotion ? motion.walk : 0;
    const still = 1 - walk;
    const thigh = legs[0]!.upper * scale, shin = legs[0]!.lower * scale;
    const ankle = (legs[0]!.ankle - (floorSoles.get(legs[0]!.names[2]) ?? 0)) * scale;
    const stride = writeWalkPose(walkPose, gait, motion?.phase ?? 0, walk, thigh + shin + ankle, motion?.stride ?? 1);
    const idle = idlePose(gait, time, sit >= 0.5);
    // Activity clip (desk work, leisure, chat) over the base pose, shared with the procedural character.
    const rawClip = motion?.clip ?? 'none';
    const effectiveClip = resolveDeskHandClip(rawClip, sit, typing);
    const clip = reducedMotion && (effectiveClip === 'sip' || effectiveClip === 'phone') ? 'desk-idle' : effectiveClip;
    const equipment = fitnessMechanism(resourceId);
    const atFitness = walk < 0.1 && !!resourceId?.startsWith("fitness.");
    const activityTime = atFitness ? (equipment?.phase ?? 0) / 3.4 : time * rig.motion.tempo + rig.motion.phaseOffset;
    const act = stepClipDriver(clipDriver, clip, activityTime, delta, sit, walk, 0, rig.motion.gestureAmount);
    const deckLift = atFitness && clip === "jog" ? FITNESS_BLUEPRINT.treadmillDeckHeight / scale : 0;
    const hips = model.bones.get('hips')?.bone;
    const standingHip = model.standingHip + standingSoleLift + Math.sin(time * 1.2) * 0.005 * still;
    if (hips) hips.position.y = deckLift + standingHip + ((seatHeight + 0.11 * scale) / scale - standingHip) * sit + (stride.bob + act.bob) / scale;
    for (let index = 0; index < 2; index++) {
      const geo = legs[index]!;
      // The visible shoe's sole may sit above or below the source body's origin.
      // Keep the seat/desk contacts fixed and solve the legs to that sole.
      const floorAnkle = (geo.ankle - (floorSoles.get(geo.names[2]) ?? 0)) * scale;
      seatedLegPose(seatHeight, seatFront, (0.11 + geo.offsetY) * scale,
        geo.upper * scale, geo.lower * scale, floorAnkle, 0.08 * scale, legPose);
      const base = legPose.thigh * sit;
      const wanted = base + stride.hip[index]! + act.thigh[index]!;
      const pitch = supportedThigh(wanted, legPose, sit);
      const actualHip = ((hips?.position.y ?? standingHip) + geo.offsetY) * scale;
      const knee = floorSeatedKnee(pitch, -base + stride.knee[index]! + act.knee[index]! + wanted - pitch,
        actualHip, geo.upper * scale, geo.lower * scale, floorAnkle, sit > 0 && walk < 1e-3 ? 1 : sit);
      const footLevel = sit + (1 - sit) * (1 - walk);
      writeSourceArmRotations(legRotations, geo.upperBasis, geo.lowerBasis, pitch, 0, knee, -(pitch + knee) * footLevel, sit);
      rotateDelta(geo.names[0], legRotations.upper);
      rotateDelta(geo.names[1], legRotations.lower);
      rotateDelta(geo.names[2], footRotation.copy(legRotations.hand).multiply(legRotations.lowerBasis));
      if (atFitness && sit > 0.95 && clip === "cycle") {
        const side = geo.offsetX < 0 ? -1 : 1;
        const goal = bikeFootGoal(side, equipment?.phase ?? 0, floorAnkle);
        solveFitnessLeg([goal[0] / gScale[0] - geo.offsetX,
          goal[1] / scale - ((hips?.position.y ?? standingHip) + geo.offsetY),
          goal[2] / gScale[2] - geo.offsetZ], geo.upper, geo.lower, fitnessLeg);
        rotateDelta(geo.names[0], fitnessRotation.copy(fitnessLeg.upper).multiply(fitnessInverse.copy(geo.upperBasis).invert()));
        rotateDelta(geo.names[1], fitnessRotation.copy(geo.upperBasis).multiply(fitnessLeg.lower).multiply(fitnessInverse.copy(geo.lowerBasis).invert()));
        rotateDelta(geo.names[2], fitnessRotation.copy(geo.lowerBasis).multiply(fitnessInverse.copy(fitnessLeg.upper).multiply(fitnessLeg.lower).invert()));
      }
    }
    rotate('spine', 0.05 * sit + 0.02 * walk + act.torsoPitch * 0.6, act.torsoYaw * 0.5, idle.torsoRoll * 0.4 * still + stride.pelvisRoll);
    rotate('chest', 0.06 * sit + act.torsoPitch * 0.4, stride.torsoTwist + act.torsoYaw * 0.5, idle.torsoRoll * 0.6 * still);
    rotate('neck', act.headPitch * 0.4, Math.sin(time * 0.5) * 0.025 + act.headYaw * 0.4);
    rotate('head', act.headPitch * 0.6 + facePose.headPitch, Math.sin(time * 0.5) * 0.035 - stride.torsoTwist + act.headYaw * 0.6 + facePose.headYaw);
    const hands = typing && clip === 'none' && !reducedMotion ? Math.sin(time * 6) * 0.045 : 0;
    // Hand goals at the desk, glided between clips; the arms follow the same solve as the procedural character.
    const actTime = time * rig.motion.tempo + rig.motion.phaseOffset;
    const goals = goalsRef.current ??= { shown: createHandGoals(), target: createHandGoals() };
    writeHandGoals(goals.target, clip, actTime, 0, reach, rig.motion.gestureAmount, sit, walk, seatHeight);
    if (atFitness && sit > 0.95 && (clip === "cycle" || resourceId === FITNESS_BLUEPRINT.cableRow.id)) {
      for (const index of [0, 1] as const) {
        const goal = fitnessHandGoal(resourceId, index ? 1 : -1, equipment);
        if (goal) { goals.target.target[index] = goal; goals.target.weight[index] = 1; }
      }
    }
    blendHandGoals(goals.shown, goals.target, 1 - Math.exp(-Math.max(0, delta) * 5));
    // Undo the actual posed torso, whose spine and chest rotate around distinct
    // pivots. A single rotation around the hips shifts desk contacts by centimetres.
    const chest = model.bones.get('chest')?.bone ?? model.scene;
    chest.updateWorldMatrix(true, false);
    const toTorso = sourceArmGoalFrame(torsoInverse, restChestFromHip, chest.matrixWorld, model.scene.matrixWorld);
    for (let index = 0; index < 2; index++) {
      const side = index === 0 ? -1 : 1;
      const [upperName, lowerName, handName] = arms[index]!.names;
      const sway = index === 0 ? -hands : hands;
      const baseX = (-0.68 + sway) * sit + stride.arm[index]! * (1 - sit) + act.arm[index]!;
      const baseZ = side * act.armOut[index]!;
      const baseElbow = -0.7 * sit + (-0.08 + stride.elbow) * (1 - sit) + act.elbow[index]!;
      const baseWrist = act.wrist[index]!;
      let pitch = baseX, roll = baseZ, elbow = baseElbow, wrist = baseWrist;
      // A hand reaching for a chair or a door (movement) takes over from the desk goal of its arm.
      const reachArm = motion?.reach[index];
      let w = goals.shown.weight[index]!;
      let goal = goals.shown.target[index]!;
      if (reachArm && reachArm.weight > 1e-3) { w = mixReachGoal(goal, w, reachArm, reachGoal); goal = reachGoal; }
      const geo = arms[index]!;
      if (w > 1e-3) {
        goalPoint.set(goal[0] / gScale[0], goal[1] / gScale[1], goal[2] / gScale[2]).applyMatrix4(toTorso);
        solveArm3D(goalPoint.x - geo.shoulder.x, goalPoint.y - geo.shoulder.y, goalPoint.z - geo.shoulder.z, geo.upper, geo.lower, armSolution);
        // Desk hand orientation is solved once below, in the actual posed parent frame.
        // Movement reaches retain their existing wrist solve and take precedence.
        const turn = (reachArm?.weight ?? 0) > 1e-3
          ? wristAngle(FINGERS, armSolution.pitch, armSolution.abduction, armSolution.elbow)
          : 0;
        pitch = baseX * (1 - w) + armSolution.pitch * w;
        roll = baseZ * (1 - w) + armSolution.abduction * w;
        elbow = baseElbow * (1 - w) + armSolution.elbow * w;
        wrist = baseWrist * (1 - w) + (turn + act.wrist[index]!) * w;
      }
      writeSourceArmRotations(armRotations, geo.upperBasis, geo.lowerBasis, pitch, roll, elbow, wrist, w);
      if (w > 1e-3 && (reachArm?.weight ?? 0) <= 1e-3) {
        // A desk elbow needs its own outward pole, rather than the old fixed
        // hinge plane that pulled the elbow down and bent the forearm steeply.
        solveArmPole([goalPoint.x - geo.shoulder.x, goalPoint.y - geo.shoulder.y, goalPoint.z - geo.shoulder.z], geo.upper, geo.lower, side, deskArm);
        deskUpper.copy(deskArm.upper).multiply(deskBasisInverse.copy(geo.upperBasis).invert());
        deskLower.copy(geo.upperBasis).multiply(deskArm.lower).multiply(deskBasisInverse.copy(geo.lowerBasis).invert());
        armRotations.upper.slerp(deskUpper, w);
        armRotations.lower.slerp(deskLower, w);
      }
      rotateDelta(upperName, armRotations.upper);
      rotateDelta(lowerName, armRotations.lower);
      rotateDelta(handName, armRotations.hand);
      const handEntry = model.bones.get(handName);
      const handParent = handEntry?.bone.parent;
      const seatRoot = lodRoot.current?.parent;
      if (handEntry && handParent && seatRoot && w > 1e-3 && (reachArm?.weight ?? 0) <= 1e-3) {
        handParent.updateWorldMatrix(true, false);
        const orientation = {
          parentWorld: handParent.matrixWorld, rootWorld: seatRoot.matrixWorld,
          direction: goals.shown.direction[index]!, palm: goals.shown.palm[index]!, localFinger: SOURCE_FINGER_AXIS,
        };
        if (writeHandOrientation(handOrientation, orientation, handOrientationScratch)) {
          if (handParent === model.bones.get(lowerName)?.bone && handEntry.bone.position.lengthSq() > 1e-10) {
            // Roll the forearm about the actual offset to its wrist. This leaves
            // the wrist position unchanged and avoids pinching all roll at the hand.
            const roll = handPronationAngle(handEntry.bone.quaternion, handOrientation, handEntry.bone.position, handOrientationScratch);
            const targetRoll = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, roll * 0.75));
            // Smooth the bounded offset, not the already-reset bone rotation.
            // This also avoids a skin snap if the shortest twist crosses +/-PI.
            forearmRoll.current[index]! += (targetRoll - forearmRoll.current[index]!) * (1 - Math.exp(-Math.max(0, delta) * 10));
            const pronation = forearmRoll.current[index]! * w;
            forearmAxis.copy(handEntry.bone.position).normalize();
            handParent.quaternion.multiply(forearmPronation.setFromAxisAngle(forearmAxis, pronation));
            handParent.updateWorldMatrix(true, false);
            // The parent changed: derive the remaining hand correction from it.
            writeHandOrientation(handOrientation, orientation, handOrientationScratch);
          }
          handEntry.bone.quaternion.slerp(handOrientation, w);
        }
      }
    }
    // The terminal source rig has no finger joints: one relaxed GPU morph per
    // hand follows the average curl, without inventing independent key presses.
    applySeatedDrape(model.seatedDrapes, sit, visual.heightMeters ?? 1.7);
    applyWalkDrape(model.walkDrapes, walk, sit);
    applyShoulderCorrectives(model.shoulderCorrectives);
    for (const binding of model.handCurls) {
      const influences = binding.mesh.morphTargetInfluences;
      if (!influences) continue;
      for (const side of [0, 1] as const) {
        const externalReach = (motion?.reach[side]?.weight ?? 0) > 1e-3;
        influences[binding.targets[side]] = externalReach ? 0 : sourceHandCurlInfluence(goals.shown.curl[side], goals.shown.weight[side]);
      }
    }
    // Props: the mug in the hand that lifts it, the phone between both hands (hidden with reduced motion).
    const mugOn = !reducedMotion && goals.shown.mug > 0.5;
    if (weightLeft.current) weightLeft.current.visible = !reducedMotion && (clip === 'lift' || clip === 'bench-curl');
    if (weightRight.current) weightRight.current.visible = !reducedMotion && (clip === 'lift' || clip === 'bench-curl');
    if (mugLeft.current) mugLeft.current.visible = mugOn && goals.shown.mugHand === 0;
    if (mugRight.current) mugRight.current.visible = mugOn && goals.shown.mugHand === 1;
    for (const [index, cup] of [[0, mugLeft.current], [1, mugRight.current]] as const) {
      if (cup) {
        const hand = arms[index].hand, seatRoot = lodRoot.current?.parent;
        if (hand && seatRoot) {
          hand.updateWorldMatrix(true, false);
          goalPoint.setFromMatrixPosition(hand.matrixWorld).applyMatrix4(torsoInverse.copy(seatRoot.matrixWorld).invert());
          cup.position.set(goalPoint.x + (index === 0 ? .045 : -.045), goalPoint.y + .015, goalPoint.z + .045);
          const weight = index === 0 ? weightLeft.current : weightRight.current;
          if (weight) weight.position.set(goalPoint.x, goalPoint.y, goalPoint.z + .04);
        }
      }
    }
    if (phoneRef.current) phoneRef.current.visible = !reducedMotion && goals.shown.phone > 0.5;
    // Separate assets retain the canonical skeleton. Copy the body's pose so
    // hair follows the head, seated posture and typing movement without drift.
    for (const [name, bone] of hairModel.bones) {
      const body = model.bones.get(name)?.bone;
      if (body) { bone.position.copy(body.position); bone.quaternion.copy(body.quaternion); bone.scale.copy(body.scale); }
    }
  });
  return <group ref={lodRoot} scale={gScale}>
    <primitive object={model.scene} dispose={null} />
    <primitive object={hairModel.scene} dispose={null} />
    {/* Props stay upright in the seat frame while following the held wrist contact. */}
    <group scale={invScale}><DumbbellProp groupRef={weightLeft} /><DumbbellProp groupRef={weightRight} /><MugProp groupRef={mugLeft} /><MugProp groupRef={mugRight} /><HospitalityProps motion={motion} goals={goalsRef} reducedMotion={reducedMotion} /></group>
    <group position={[PHONE_CENTRE[0] / gScale[0], PHONE_CENTRE[1] / gScale[1], PHONE_CENTRE[2] / gScale[2]]} scale={invScale}>
      <PhoneProp groupRef={phoneRef} />
    </group>
  </group>;
}
