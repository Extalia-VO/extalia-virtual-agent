import { InteriorPart } from '../../InteriorPart';

/** Floor-standing copier, storage, tabletop printer and recycling point. Front = +Z. */
export function PrintCopyStation({position=[0,0,0],rotationY=0}:{position?:[number,number,number];rotationY?:number}) {
  return <group position={position} rotation={[0,rotationY,0]}>
    <InteriorPart model="copier" position={[-.72,0,0]}>
      <mesh position={[0,.54,0]} castShadow><boxGeometry args={[.82,1.08,.72]}/><meshStandardMaterial color="#d9dcdd" roughness={.76}/></mesh>
      <mesh position={[0,1.14,-.02]}><boxGeometry args={[.74,.16,.62]}/><meshStandardMaterial color="#303a40" roughness={.48}/></mesh>
      <mesh position={[.18,1.21,.32]} rotation={[-.25,0,0]}><boxGeometry args={[.22,.12,.03]}/><meshStandardMaterial color="#4b7886" emissive="#17313a" emissiveIntensity={.45}/></mesh>
    </InteriorPart>
    <InteriorPart model="print-supply-cabinet" position={[.42,0,0]}>
      <mesh position={[0,.48,0]} castShadow><boxGeometry args={[1.05,.96,.62]}/><meshStandardMaterial color="#c9c5bc" roughness={.88}/></mesh>
    </InteriorPart>
    <InteriorPart model="printer" position={[.42,.96,0]}>
      <mesh position={[0,.15,0]}><boxGeometry args={[.58,.30,.46]}/><meshStandardMaterial color="#4a555b" roughness={.55}/></mesh>
      <mesh position={[0,.35,-.03]}><boxGeometry args={[.46,.10,.34]}/><meshStandardMaterial color="#e1e3e3" roughness={.7}/></mesh>
    </InteriorPart>
    <InteriorPart model="recycle-bin" position={[1.25,0,.04]}>
      <mesh position={[0,.31,0]}><cylinderGeometry args={[.24,.20,.62,12]}/><meshStandardMaterial color="#738188" roughness={.82}/></mesh>
    </InteriorPart>
  </group>;
}
