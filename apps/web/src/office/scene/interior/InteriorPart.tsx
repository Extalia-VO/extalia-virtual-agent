import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Material, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useSolarEnvironment } from '../Environment';

export const INTERIOR_MODELS = [
  'storage-cabinet','display-cabinet','bookshelf','bookshelf-open','copier','console-table','coffee-table',
  'print-supply-cabinet','printer','recycle-bin','bar-counter','bar-back','coffee-machine',
  'bar-stool-base','bar-stool-seat','stemware-rack','server-rack','tv-console','tv-housing',
  'game-console','game-controller','arcade-shell','foosball-table','minibar','lounge-round-table',
  'treadmill-frame','treadmill-belt','bike-frame','bike-crank','bike-pedal','dumbbell-rack',
  'strength-bench','dumbbell','yoga-mat','gym-storage','cable-tower','cable-stack','cable-handle','cable-seat',
  'floor-lamp','pendant-light','decor-plant','wall-art','decor-vignette','food-plate','drink-cup',
] as const;
export type InteriorModel = typeof INTERIOR_MODELS[number];
const urls = import.meta.glob<string>('/public-assets/furniture/interior-library.glb', { eager:true, query:'?url', import:'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('interiors') === 'procedural';
let library: ReadonlyMap<string,Object3D> | null = null, requested = false;
const listeners = new Set<()=>void>();
const subscribe = (listener:()=>void) => { listeners.add(listener);return()=>{listeners.delete(listener)}; };
async function load() {
  const url=procedural?undefined:urls['/public-assets/furniture/interior-library.glb'];
  if(!url||requested)return;
  requested=true;
  try {
    const gltf=await new GLTFLoader().loadAsync(url);
    library=new Map(INTERIOR_MODELS.flatMap(name=>{const node=gltf.scene.getObjectByName(name);return node?[[name,node] as const]:[]}));
  } catch { /* A missing local library keeps the complete procedural furniture. */ }
  listeners.forEach(listener=>listener());
}
export interface InteriorInstance {root:Object3D;owned:Material[];lamps:MeshStandardMaterial[];leds:MeshStandardMaterial[]}
/** Immutable geometry/materials are shared; per-instance tint and emissions are isolated. */
export function createInteriorInstance(source:Object3D,upholsteryColor?:string):InteriorInstance {
  const root=source.clone(true),owned:Material[]=[],lamps:MeshStandardMaterial[]=[],leds:MeshStandardMaterial[]=[];
  const swaps=new Map<Material,Material>();
  root.traverse(node=>{
    const mesh=node as Mesh;if(!mesh.isMesh)return;
    const replace=(material:Material)=>{
      const cached=swaps.get(material);if(cached)return cached;
      const lamp=/interior lamp diffuser/i.test(material.name),led=/server led/i.test(material.name);
      const tint=upholsteryColor!==undefined&&/upholstery|leather/i.test(material.name);
      const glass=material.transparent;
      if(!lamp&&!led&&!tint&&!glass)return material;
      const copy=material.clone() as MeshStandardMaterial;
      if(tint)copy.color.set(upholsteryColor!);
      if(glass)copy.depthWrite=false;
      if(lamp)lamps.push(copy);if(led)leds.push(copy);
      swaps.set(material,copy);owned.push(copy);return copy;
    };
    mesh.material=Array.isArray(mesh.material)?mesh.material.map(replace):replace(mesh.material);
    const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    mesh.castShadow=!materials.every(m=>m.transparent);mesh.receiveShadow=true;
  });
  return{root,owned,lamps,leds};
}
export function updateInteriorEmission(instance:Pick<InteriorInstance,'lamps'|'leds'>,factor:number,time:number,reducedMotion:boolean,seed=0):void {
  for(const lamp of instance.lamps)lamp.emissiveIntensity=factor>.05?.5+factor*3.5:0;
  instance.leds.forEach((led,index)=>{led.emissiveIntensity=reducedMotion?1.1:.85+.45*(.5+.5*Math.sin(time*(2.2+index*.31)+seed+index*2.1));});
}
function Emission({instance,seed}:{instance:InteriorInstance;seed:number}) {
  const {state,reducedMotion}=useSolarEnvironment(),factor=state.factors.interiorLightFactor;
  useEffect(()=>updateInteriorEmission(instance,factor,0,reducedMotion,seed),[instance,factor,reducedMotion,seed]);
  useFrame(({clock})=>{if(instance.leds.length)updateInteriorEmission(instance,factor,clock.elapsedTime,reducedMotion,seed)});
  return null;
}
/** Named Blender part with a complete fallback; articulated parents retain their runtime transforms. */
export function InteriorPart({model,children,position,modelScale,upholsteryColor,animationSeed=0}:{
  model:InteriorModel;children?:ReactNode;position?:readonly[number,number,number];modelScale?:readonly[number,number,number];upholsteryColor?:string;animationSeed?:number;
}) {
  const assets=useSyncExternalStore(subscribe,()=>library,()=>null);
  useEffect(()=>{void load()},[]);
  const source=assets?.get(model);
  const instance=useMemo(()=>source?createInteriorInstance(source,upholsteryColor):null,[source,upholsteryColor]);
  useEffect(()=>()=>{instance?.owned.forEach(material=>material.dispose())},[instance]);
  return <group name={`interior-part-${model}`} position={position?[...position]:[0,0,0]} userData={{officeDynamic:true,interiorModel:model,interiorAuthored:!!instance}}>
    {instance?<><group scale={modelScale?[...modelScale]:[1,1,1]}><primitive object={instance.root} dispose={null}/></group>
      {(instance.lamps.length>0||instance.leds.length>0)&&<Emission instance={instance} seed={animationSeed}/>}</>:children}
  </group>;
}
