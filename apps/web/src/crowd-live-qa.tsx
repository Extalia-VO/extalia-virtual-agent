import { Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useProgress } from '@react-three/drei';
import type { Group, Object3D } from 'three';
import { FurnishedFloors } from './office/scene/FurnishedFloors';
import { ModelInstanceBatches } from './office/scene/ModelInstanceBatches';
import { SceneEnvironment } from './office/scene/Environment';
import { SceneLighting } from './office/scene/environment/SceneLighting';
import { OfficeCharacter } from './office/scene/avatars/OfficeCharacter';
import { gaitParameters } from './office/scene/avatars/gait';
import { deskReachForSeat } from './office/scene/avatars/deskReach';
import { WalkingClearance } from './office/scene/movement/naturalClearance';
import { MovementDirector } from './office/scene/movement/director';
import { liveElevatorAccess } from './office/scene/movement/elevatorAccess';
import { tickElevator, elevatorSnapshot } from './office/scene/prefabs/architecture/elevatorController';
import { officeNavigation, type SeatApproach } from './office/scene/movement/navGraph';
import { crowdWatchActor, type Mover } from './office/scene/movement/mover';
import { isDeskChair } from './office/scene/interior/deskChairs';
import { getDoorPortalsSnapshot, getMovingOccupantsSnapshot, getNearbyMovingOccupantsSnapshot, trackMovingOccupant, trackStationaryOccupant } from './office/scene/interior/occupants/movingOccupants';
import { doorTraffic } from './office/scene/interior/doorTrafficRegistry';
import type { OfficeAgentAllocation } from './office/scene/interior/seating';
import type { OfficeAgent } from './office/presence';
import type { Point3 } from './office/scene/layout';

const nav=officeNavigation(),field=new WalkingClearance(getDoorPortalsSnapshot);
let roots:Object3D[]=[],simNow=0,director:MovementDirector|null=null,agents:OfficeAgent[]=[],allocations:OfficeAgentAllocation[]=[];
let renderActors:(list:Mover[])=>void=()=>{},renderData:()=>void=()=>{};
let events:unknown[]=[],overlaps:unknown[]=[],holes:unknown[]=[],missing:unknown[]=[],velocities:unknown[]=[],timelines:unknown[]=[],minSeparation=Infinity,maxStep=0,maxActorCount=0;
const seenHoles=new Set<string>(),seenMissing=new Set<string>(),seenOverlap=new Set<string>();
let options:{sameFloor?:boolean;variant?:number;meeting?:boolean}={},lastInitiative:string|null=null,lastLease=0;
const admitted=new Map<string,unknown>(),retired:unknown[]=[],seatedAchievements:unknown[]=[],seenSeats=new Set<string>();
const operatorConflicts:unknown[]=[],seenOperators=new Set<string>();
const doorEvents:unknown[]=[],doorStates=new Map<string,string>();
let floorView:1|2|3=3;
const initiativeEvents:unknown[]=[],clusterHistory=new Map<string,unknown>(),registryDrift:unknown[]=[];
let aim:Point3=[1.25,12.8,-13],scheduled:{at:number;name:string;action:()=>void}[]=[],desired=20;
const originClock=performance.now.bind(performance);
function clocked<T>(fn:()=>T):T{const descriptor=Object.getOwnPropertyDescriptor(performance,'now');Object.defineProperty(performance,'now',{configurable:true,value:()=>simNow});try{return fn();}finally{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as unknown as {now?:()=>number}).now;}}
const point=(p:Readonly<Point3>):Point3=>[p[0],p[1],p[2]];
const distance=(a:Readonly<Point3>,b:Readonly<Point3>)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
function actor(m:Mover){return{id:m.id,phase:m.phase,pos:point(m.position),previous:point(m.prev),opacity:m.opacity,chairPull:m.chairPull,chairSide:m.chairSide,motionSit:m.motion.sit,yaw:m.yaw,speed:m.monitor.speed,stationary:m.monitor.stationarySeconds,reason:m.monitor.reason,actionable:m.monitor.actionable,recovery:m.recovery.attempts,seat:m.seat?.seatId,seatExit:m.seatExit?.seatId,backing:m.backing,goal:m.goal?.kind==='seat'?m.goal.seat.seatId:m.goal?.node,pending:m.pending?.kind==='seat'?m.pending.seat.seatId:m.pending?.node,stepIndex:m.stepIndex,steps:m.steps.length,next:m.steps[m.stepIndex],target:m.target&&point(m.target),crowdYield:m.crowdYield,chair:m.chair&&{kind:m.chair.kind,seatId:m.chair.seat.seatId,beat:m.chair.beat,timer:m.chair.timer,path:m.chair.path},door:m.door&&{id:m.door.id,kind:m.door.kind,beat:m.door.beat,timer:m.door.timer,queueIndex:m.door.queueIndex,traffic:m.door.traffic,queueYield:m.door.queueYield,entrySide:m.door.entrySide,path:m.door.path},trip:m.trip&&{id:m.trip.id,stage:m.trip.stage,from:m.trip.from,to:m.trip.to}};}
function diagnose(id:string){return clocked(()=>{const m=director?.list.find(m=>m.id===id);if(!m)return null;const next=m.steps[m.stepIndex];return{actor:actor(m),watch:crowdWatchActor(m),neighbors:getNearbyMovingOccupantsSnapshot(m.id,m.position),currentClear:field.segmentClear(m.position,m.position,.29),nextStaticClear:next?.kind==='walk'?field.segmentClear(m.position,next.to,.29):null,stage:m.seat?.staging,stageClear:m.seat&&field.segmentClear(m.seat.staging,m.seat.staging,.29)};});}
const seats=[...nav.seats.values()].filter(s=>s.floor===3&&isDeskChair(s.seatId));
const office=(id:string,index:number):OfficeAgent=>({id,sessionId:'synthetic-session',agentId:'worker-'+index,parentId:'synthetic-parent',displayName:id,status:'working',control:'observed',running:true,activity:'edit'});
const allocation=(agentId:string,s:SeatApproach):OfficeAgentAllocation=>({agentId,id:s.seatId,resourceId:s.seatId,floor:s.floor,position:point(s.seat),rotationY:s.rotationY,seatHeight:s.seatHeight});
function reconcile(){if(new Set(allocations.map(a=>a.resourceId)).size!==allocations.length)throw new Error('Fixture allocated duplicate target seats');clocked(()=>director!.update({allocations,agents,reducedMotion:false,gaitOf:id=>gaitParameters({gait:Number(id.replace(/\D/g,''))%2?'feminine':'masculine'})}));renderData();}
function summary(){return clocked(()=>({seconds:simNow/1000,count:director?.list.length??0,desired,maxActorCount,minSeparation,maxStep,events,doorEvents,overlaps,holes,missing,velocities,timelines,options,admitted:[...admitted.values()],retired,seatedAchievements,operatorConflicts,initiativeEvents,clusterHistory:[...clusterHistory.values()],registryDrift,crowd:director?.crowdDiagnostics(),actors:director?.list.map(actor)??[],registry:getMovingOccupantsSnapshot(),doors:doorTraffic.portals().map(p=>({id:p.id,amount:doorTraffic.amount(p.id),queue:doorTraffic.queueStatus(p.id)})),elevators:['A','B'].map(id=>elevatorSnapshot(id as 'A'|'B'))}));}
function setup(total=20,configuration:{sameFloor?:boolean;variant?:number;meeting?:boolean}={}){options=configuration;floorView=options.meeting?2:3;aim=options.meeting?[-5,6.4,-3]:[1.25,12.8,-13];
 if(director)throw new Error('Use fresh page for each live-registry fixture');
 simNow=0;desired=total;field.rebuild(roots);events=[];overlaps=[];holes=[];missing=[];velocities=[];timelines=[];minSeparation=Infinity;maxStep=0;
 director=new MovementDirector({navigation:nav,elevators:liveElevatorAccess,doors:doorTraffic,trackWalker:trackMovingOccupant,trackBody:trackStationaryOccupant,nearbyWalkers:getNearbyMovingOccupantsSnapshot,walkable:field.segmentClear,seatContactClear:field.seatContactClear,seatExitClear:field.seatExitClear,seatEntryClear:field.seatEntryClear,chairMotionClear:field.chairMotionClear},()=>simNow);
 director.wander=false;director.subscribe(()=>renderActors([...director!.list]));
 const preferred=options.meeting?['meeting-a','meeting-b']:['multi-engine','flex','sanctuary','research','executive-studio'];
 const primary=options.meeting?[...nav.seats.values()].filter(s=>s.floor===2&&s.seatStyle==='meeting'&&s.roomId.startsWith('meeting')):seats;
 const choices=[...primary].sort((a,b)=>preferred.indexOf(a.roomId)-preferred.indexOf(b.roomId)||a.seatId.localeCompare(b.seatId));
 if(options.sameFloor&&!options.meeting)choices.push(...[...nav.seats.values()].filter(s=>s.floor===3&&s.roomId==='rooftop-terrace'&&s.seatStyle==='armchair').slice(0,Math.max(0,total-choices.length)));
 choices.push(...[...nav.seats.values()].filter(s=>s.floor===2&&isDeskChair(s.seatId)).slice(0,Math.max(0,total-choices.length)));
 if(choices.length<total)throw new Error('Insufficient unique office chairs');
 if(options.variant){const rotated=choices.splice(0);const rooms=preferred.map(room=>rotated.filter(s=>s.roomId===room));while(rooms.some(r=>r.length))for(const room of rooms)if(room.length)choices.push(room.shift()!);choices.push(...rotated.filter(s=>!preferred.includes(s.roomId)));}
 const initial=Math.ceil(total/2),all=Array.from({length:total},(_,i)=>office('live-'+String(i).padStart(2,'0'),i));
 agents=all.slice(0,initial);allocations=agents.map((a,i)=>allocation(a.id,choices[i]!));reconcile();
 const rotate=()=>{const list=allocations.map(a=>nav.seats.get(a.resourceId)!);allocations=allocations.map((a,i)=>allocation(a.agentId,list[(i+1)%list.length]!));reconcile();};
 scheduled=[{at:8000,name:'late-arrivals',action:()=>{agents=all;allocations=all.map((a,i)=>allocation(a.id,choices[i]!));reconcile();}},
 {at:40000,name:'occupied-seat-reassignment',action:rotate},
 {at:80000,name:'depart-four',action:()=>{const ids=new Set(agents.slice(0,4).map(a=>a.id));agents=agents.filter(a=>!ids.has(a.id));allocations=allocations.filter(a=>!ids.has(a.agentId));reconcile();}},
 {at:82000,name:'replace-departing-workers',action:()=>{const used=new Set(allocations.map(a=>a.resourceId));const free=choices.filter(s=>!used.has(s.seatId)).slice(0,4);const additions=free.map((s,i)=>office('replacement-'+i,30+i));agents.push(...additions);allocations.push(...additions.map((a,i)=>allocation(a.id,free[i]!)));reconcile();}},
 {at:110000,name:'cross-room-reassignment',action:rotate},
 {at:145000,name:options.sameFloor?'same-floor-reassignment':'cross-floor-elevator-reassignment',action:()=>{if(options.sameFloor){rotate();return;}const used=new Set(allocations.map(a=>a.resourceId));const free=[...nav.seats.values()].filter(s=>s.floor===2&&isDeskChair(s.seatId)&&!used.has(s.seatId));allocations=allocations.map((a,i)=>i<2?allocation(a.agentId,free[i]!):a);reconcile();}},
 {at:220000,name:'all-depart',action:()=>{agents=[];allocations=[];reconcile();}}];
 renderActors([...director.list]);return{...summary(),chairs:choices.slice(0,total).map(s=>({id:s.seatId,room:s.roomId,seat:s.seat,stage:s.staging})),colliderCount:field.colliderCount};
}
function record(){
 for(const m of director!.list){const state=JSON.stringify([m.phase,m.door?.id,m.door?.kind,m.door?.beat]);const previous=doorStates.get(m.id);if(state!==previous){if(m.door||previous?.includes('doorwork'))doorEvents.push({seconds:simNow/1000,previous,actor:actor(m),doors:doorTraffic.portals().filter(p=>p.id===m.door?.id||previous?.includes(p.id)).map(p=>({id:p.id,amount:doorTraffic.amount(p.id),queue:doorTraffic.queueStatus(p.id)}))});doorStates.set(m.id,state);}}

 maxActorCount=Math.max(maxActorCount,director!.list.length);
 const decision=director!.crowdDiagnostics(),initiative=decision.initiative,key=initiative?initiative.actorId+':'+initiative.groupId:null;
 if(initiative&&(key!==lastInitiative||initiative.remainingSeconds>lastLease+.1)){const m=director!.list.find(m=>m.id===initiative.actorId);initiativeEvents.push({seconds:simNow/1000,source:'MovementDirector.tick/CrowdWatch',initiative,actor:m&&actor(m),appliedEscape:!!m?.crowdYield});}lastInitiative=key;lastLease=initiative?.remainingSeconds??0;
 for(const group of decision.groups){const previous=clusterHistory.get(group.id) as {maximumSeconds:number}|undefined;if(!previous||group.seconds>previous.maximumSeconds)clusterHistory.set(group.id,{...group,maximumSeconds:group.seconds,observedAt:simNow/1000,source:'MovementDirector.tick/CrowdWatch',actors:director!.list.filter(m=>group.members.includes(m.id)).map(actor)});}
 const operators=new Map<string,Mover[]>();for(const m of director!.list){if(m.opacity<=0||(!['seated','standing','sitting','chairing','seatwork'].includes(m.phase)&&!m.seatExit))continue;const seatId=m.chair?.seat.seatId??m.staticSeat?.seat.seatId??m.seatExit?.seatId??m.seat?.seatId;if(!seatId)continue;const list=operators.get(seatId)??[];list.push(m);operators.set(seatId,list);}for(const[seatId,list]of operators){if(list.length<2)continue;const key=seatId+':'+list.map(m=>m.id).sort().join(':');if(!seenOperators.has(key)){seenOperators.add(key);operatorConflicts.push({seconds:simNow/1000,seatId,actors:list.map(actor)});}}
 for(const m of director!.list){if(!admitted.has(m.id))admitted.set(m.id,{id:m.id,seconds:simNow/1000,actor:actor(m)});if(m.phase==='seated'){const key=m.id+':'+m.seat?.seatId;if(!seenSeats.has(key)){seenSeats.add(key);seatedAchievements.push({id:m.id,seat:m.seat?.seatId,seconds:simNow/1000});}}}
 const list=director!.list.filter(m=>m.phase!=='gone'&&m.opacity>0),registry=getMovingOccupantsSnapshot(),ids=new Set(registry.map(r=>r.id));
 for(const m of list){
  const reg=registry.find(r=>r.id===m.id);if(reg&&distance(reg.position,m.position)>.01&&registryDrift.length<20)registryDrift.push({seconds:simNow/1000,actor:actor(m),registry:reg,distance:distance(reg.position,m.position)});
  const step=distance(m.prev,m.position);maxStep=Math.max(maxStep,step);
  if(!ids.has(m.id)&&!seenMissing.has(m.phase)){seenMissing.add(m.phase);missing.push({seconds:simNow/1000,actor:actor(m),registry});}
  const near=getNearbyMovingOccupantsSnapshot(m.id,m.position),nearIDs=new Set(near.map(n=>n.id));
  for(const other of list){if(other===m||Math.abs(other.position[1]-m.position[1])>.8)continue;const d=distance(m.position,other.position);minSeparation=Math.min(minSeparation,d);
   const key=m.phase+':'+other.phase;if(d<1.2&&!nearIDs.has(other.id)&&!seenHoles.has(key)){seenHoles.add(key);holes.push({seconds:simNow/1000,distance:d,self:actor(m),missingNeighbor:actor(other),actualNearby:near,registry});}
   const pair=[m.id,other.id].sort().join(':');if(d<.559&&!seenOverlap.has(pair)){seenOverlap.add(pair);overlaps.push({seconds:simNow/1000,distance:d,a:actor(m),b:actor(other),aSeesB:nearIDs.has(other.id),registry});}
  }
 }
 if(velocities.length<20){const r=registry.find(r=>Math.hypot(r.velocity[0],r.velocity[2])>.1);if(r)velocities.push({seconds:simNow/1000,sample:r});}
}
async function run(seconds=240,chunk=3){
 for(let f=0;f<Math.ceil(seconds*30);f++){
  simNow+=1000/30;clocked(()=>{while(scheduled[0]&&scheduled[0].at<=simNow){const event=scheduled.shift()!;events.push({seconds:simNow/1000,name:event.name});event.action();}for(const p of doorTraffic.portals())if(p.door.sliding)doorTraffic.slideStep(p.id,p.door,1/30);tickElevator(1/30,'A');tickElevator(1/30,'B');const previous=[...director!.list];director!.tick(1/30);for(const m of previous)if(!director!.list.some(a=>a.id===m.id)){const goal=m.goal?.kind==='leave'?nav.waypoints.get(m.goal.node)?.position:null;retired.push({seconds:simNow/1000,actor:actor(m),exitDistance:goal?Math.hypot(m.position[0]-goal[0],m.position[1]-goal[1],m.position[2]-goal[2]):null,completedExit:m.phase==='gone'&&!!goal&&distance(m.position,goal)<.05});}record();});
  if(f%150===0)timelines.push({seconds:simNow/1000,actors:director!.list.map(actor)});
  if(f%(30*chunk)===0)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
 }
 await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));return summary();
}
function Probe(){const {scene,camera}=useThree();const frames=useRef(0);useFrame(()=>{camera.position.set(aim[0]-18,aim[1]+23,aim[2]-24);camera.lookAt(...aim);camera.updateMatrixWorld();if(!useProgress.getState().active&&++frames.current===5){roots=[];scene.traverse(n=>{if(/^furnished-floor-[123]$/.test(n.name))roots.push(n);});field.rebuild(roots);document.title='Live crowd ready';}});useEffect(()=>{(window as unknown as {liveQA:unknown}).liveQA={version:'live5',setup,run,summary,diagnose,field,seats:()=>seats,aim:(p:Point3)=>{aim=p;},loading:()=>useProgress.getState().active,rendered:()=>director?.list.filter(m=>{let count=0;scene.getObjectByName('live-actor:'+m.id)?.traverse(n=>{if((n as Object3D&{isMesh?:boolean}).isMesh)count++;});return count>3;}).length??0,clock:()=>({simulated:simNow,real:originClock()})};},[scene]);return null;}
function Actor({m}:{m:Mover}){const group=useRef<Group>(null);useFrame(()=>{if(group.current){group.current.position.set(...m.position);group.current.rotation.y=m.yaw;group.current.visible=m.opacity>0&&m.phase!=='gone';}});const agent=agents.find(a=>a.id===m.id)??office(m.id,0);return <group ref={group} name={'live-actor:'+m.id} position={m.position}><OfficeCharacter agent={agent} position={[0,0,0]} seated={MovementDirector.seatedPose(m)} seatHeight={m.seat?.seatHeight} seatFront={m.seat?.seatFront} motion={m.motion} resourceId={m.seat?.seatId} desk={deskReachForSeat(m.seat?.seatId)} reducedMotion={false} onSelect={()=>{}}/></group>;}
function App(){const [list,setList]=useState<Mover[]>([]),[,refresh]=useState(0);useEffect(()=>{renderActors=setList;renderData=()=>refresh(v=>v+1);},[]);return <main style={{height:'100vh',background:'#dbe7ec'}}><div style={{position:'absolute',zIndex:2,background:'white',padding:10}}>Real MovementDirector + live measured registry · synthetic actors · accelerated 30 Hz · {list.length} actors</div><Canvas orthographic camera={{position:[-18,36,-37],zoom:68,near:.1,far:300}} dpr={1} gl={{antialias:false}}><ModelInstanceBatches/><SceneEnvironment dark={false} reducedMotion={false} lightOverride="on"><SceneLighting/><FurnishedFloors view={floorView} agents={agents} allocations={allocations} language="en"/><Probe/><Suspense fallback={null}>{list.map(m=><Actor key={m.id} m={m}/>)}</Suspense></SceneEnvironment></Canvas></main>;}
createRoot(document.getElementById('root')!).render(<App/>);
