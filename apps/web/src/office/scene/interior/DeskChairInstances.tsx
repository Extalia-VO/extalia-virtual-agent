 
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import type { BufferGeometry, Group, InstancedMesh } from 'three';
import { Matrix4, MeshStandardMaterial } from 'three';
import { ProceduralOfficeChairMeshes, EXECUTIVE_CHAIR_COLOR, TASK_CHAIR_COLOR } from './prefabs/furniture/OfficeChair';
import { chairOffset, deskChairMotion, deskChairRegistry, type DeskChairMotion, type DeskChairVariant, type RegisteredDeskChair } from './deskChairs';
import { mergeChair } from './chairGeometry';
import { useOfficeChairModel } from './chairModels';

const scratch = { offset: new Matrix4(), turn: new Matrix4(), out: new Matrix4() };

function writeChair(target: InstancedMesh, index: number, chair: RegisteredDeskChair, pull: number, side: 1 | -1) {
  const { back, turn } = chairOffset(pull, chair.resourceId, side);
  scratch.offset.makeTranslation(0, 0, -back);
  scratch.turn.makeRotationY(turn);
  scratch.out.multiplyMatrices(chair.matrix, scratch.offset).multiply(scratch.turn);
  target.setMatrixAt(index, scratch.out);
}

/** Every movable chair of one variant on one floor, as a single instanced draw. */
function ChairVariant({ floor, variant, motion }: { floor: 1 | 2 | 3; variant: DeskChairVariant; motion: DeskChairMotion }) {
  const template = useRef<Group>(null);
  const [backup, setGeometry] = useState<BufferGeometry | null>(null);
  const authored = useOfficeChairModel(variant);
  const geometry = authored ?? backup;
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.14 }), []);
  useLayoutEffect(() => {
    if (!template.current) return;
    const merged = mergeChair(template.current);
    setGeometry(merged);
    return () => merged?.dispose();
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  const version = useSyncExternalStore(deskChairRegistry.subscribe, deskChairRegistry.version);
  const chairs = useMemo(() => { void version; return deskChairRegistry.onFloor(floor, variant); }, [floor, variant, version]);
  const mesh = useRef<InstancedMesh>(null);
  const applied = useRef<Float64Array>(new Float64Array(0));
  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    applied.current = new Float64Array(chairs.length * 2);
    chairs.forEach((chair, index) => {
      const pull = motion.pull(chair.resourceId), side = motion.side(chair.resourceId);
      writeChair(target, index, chair, pull, side);
      applied.current[index * 2] = pull;
      applied.current[index * 2 + 1] = side;
    });
    target.count = chairs.length;
    target.instanceMatrix.needsUpdate = true;
  }, [chairs, geometry, motion]);
  const seen = useRef(-1);
  useFrame(() => {
    const target = mesh.current;
    if (!target || seen.current === motion.version()) return;
    seen.current = motion.version();
    let dirty = false;
    for (let index = 0; index < chairs.length; index++) {
      const chair = chairs[index]!, pull = motion.pull(chair.resourceId), side = motion.side(chair.resourceId);
      if (applied.current[index * 2] === pull && applied.current[index * 2 + 1] === side) continue;
      applied.current[index * 2] = pull;
      applied.current[index * 2 + 1] = side;
      writeChair(target, index, chair, pull, side);
      dirty = true;
    }
    if (dirty) target.instanceMatrix.needsUpdate = true;
  });
  return <>
    <group ref={template} visible={false}><ProceduralOfficeChairMeshes highBack={variant === 'executive'} color={variant === 'executive' ? EXECUTIVE_CHAIR_COLOR : TASK_CHAIR_COLOR} /></group>
    {/* Geometry/material are supplied by reference; Fiber can still dispose each mesh's instance buffers. */}
    {geometry && chairs.length > 0 && <instancedMesh name={`${authored ? 'blender' : 'procedural'}-chairs-${variant}-floor-${floor}`} key={chairs.length} ref={mesh} args={[geometry, material, chairs.length]} castShadow receiveShadow frustumCulled={false} />}
  </>;
}

/** The desk chairs of one furnished floor; mounted inside that floor's group so they share its visibility. */
export function DeskChairInstances({ floor, motion = deskChairMotion }: { floor: 1 | 2 | 3; motion?: DeskChairMotion }) {
  return <>
    <ChairVariant floor={floor} variant="task" motion={motion} />
    <ChairVariant floor={floor} variant="executive" motion={motion} />
  </>;
}
