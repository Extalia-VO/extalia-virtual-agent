import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { sourceTrouserLining } from '../src/office/scene/avatars/sourceTrouserLining';

function shell() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0,.8,.1, .1,.8,.1, 0,.9,.1, 0,1,.2, .1,1,.2, 0,1.1,.2],3));
  geometry.setAttribute('normal', new Float32BufferAttribute(Array(6).fill([0,0,2]).flat(),3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array(6).fill([0,1,0,0]).flat(),4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array(6).fill([.5,.5,0,0]).flat(),4));
  geometry.setAttribute('uv', new Float32BufferAttribute(Array(12).fill(.5),2));
  geometry.morphAttributes.position = [new Float32BufferAttribute(Array(18).fill(.01),3)];
  geometry.setIndex([0,1,2,3,4,5]); geometry.addGroup(0,3,0); geometry.addGroup(3,3,1);
  return new SkinnedMesh(geometry,[new MeshStandardMaterial({name:'OriginalBottom_Test',transparent:true}),new MeshStandardMaterial({name:'Skin_Test'})]);
}

describe('opaque backing under an explicitly selected cutout trouser shell',()=>{
  it('backs only cloth with a normalized inward offset, preserving skin, UVs, bindings and drapes',()=>{
    const mesh=shell(), source=mesh.geometry, lining=sourceTrouserLining(mesh)!;
    expect([...lining.index!.array]).toEqual([0,1,2]);
    expect(lining.getAttribute('position').getZ(0)).toBeCloseTo(.0985,6);
    expect(lining.getAttribute('position').getZ(3)).toBeCloseTo(.2,6);
    for(const name of ['skinIndex','skinWeight','uv']) expect(lining.getAttribute(name).array).toEqual(source.getAttribute(name).array);
    expect(lining.morphAttributes.position![0]!.array).toEqual(source.morphAttributes.position![0]!.array);
    expect(source.getAttribute('position').getZ(0)).toBeCloseTo(.1,6);
    expect([...source.index!.array]).toEqual([0,1,2,3,4,5]);
    expect((mesh.material as MeshStandardMaterial[])[0]!.transparent).toBe(true);
    expect(sourceTrouserLining(mesh)).toBe(lining);
  });
  it('never turns skin-only or unclassified geometry into fabric',()=>{
    const mesh=shell(); mesh.material=[new MeshStandardMaterial({name:'Skin_Test'}),new MeshStandardMaterial({name:'OriginalAccent_Test'})];
    expect(sourceTrouserLining(mesh)).toBeUndefined();
  });
});
