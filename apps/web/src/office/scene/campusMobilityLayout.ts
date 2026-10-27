import { FRONT_APPROACH } from './campusSiteLayout';

export const VEHICLE_MODELS = ['mobility-sedan', 'mobility-suv', 'mobility-jeep', 'mobility-mpv', 'mobility-hatchback', 'mobility-truck', 'mobility-double-cabin', 'mobility-ev'] as const;
export type MobilityVehicle = (typeof VEHICLE_MODELS)[number];
export type MobilityModel = MobilityVehicle | 'mobility-charger' | 'mobility-cycle-shelter';
export const MOBILITY_MODELS: readonly MobilityModel[] = [...VEHICLE_MODELS, 'mobility-charger', 'mobility-cycle-shelter'];
/** Body dimensions in metres; wheels touch y=0 and each vehicle faces +Z. */
export const VEHICLE_SPECS: Readonly<Record<MobilityVehicle, { length: number; width: number; height: number; wheel: number; cabinZ: number; cabinLength: number; cabinBase: number; windows: number; cargo: boolean }>> = {
  'mobility-sedan': { length:4.46,width:1.79,height:1.45,wheel:.30,cabinZ:-.14,cabinLength:2.35,cabinBase:.77,windows:2,cargo:false },
  'mobility-suv': { length:4.67,width:1.90,height:1.82,wheel:.36,cabinZ:-.17,cabinLength:3.07,cabinBase:.84,windows:3,cargo:false },
  'mobility-jeep': { length:4.10,width:1.88,height:1.89,wheel:.38,cabinZ:-.28,cabinLength:2.50,cabinBase:.85,windows:2,cargo:false },
  'mobility-mpv': { length:4.91,width:1.89,height:1.86,wheel:.32,cabinZ:-.10,cabinLength:3.83,cabinBase:.78,windows:3,cargo:false },
  'mobility-hatchback': { length:3.82,width:1.72,height:1.50,wheel:.29,cabinZ:-.25,cabinLength:2.65,cabinBase:.76,windows:2,cargo:false },
  'mobility-truck': { length:5.02,width:1.93,height:1.90,wheel:.36,cabinZ:.92,cabinLength:1.86,cabinBase:.84,windows:1,cargo:true },
  'mobility-double-cabin': { length:5.02,width:1.95,height:1.84,wheel:.35,cabinZ:.40,cabinLength:2.74,cabinBase:.83,windows:2,cargo:true },
  'mobility-ev': { length:4.12,width:1.80,height:1.53,wheel:.31,cabinZ:-.10,cabinLength:2.60,cabinBase:.76,windows:2,cargo:false },
};
export function isMobilityVehicle(model: MobilityModel): model is MobilityVehicle { return model in VEHICLE_SPECS; }
export const PARKING = Object.freeze({ west: -51.5, east: -33.5, north: -15, south: 20, top: -.22, aisleX: -42.5, bayDepth: 5.5, bayWidth: 3.2,
  entranceZ: -28.5, entryX: -52, footwayX: -32.4 });
/** Six perimeter poles leave the drive aisle, occupied bays, chargers and east footway clear. */
export const PARKING_LIGHTS = Object.freeze([-13, 3, 18].flatMap(z => [
  { id: `parking-west-${z}`, x: -51, z, poolX: -46.8 },
  { id: `parking-east-${z}`, x: -34.2, z, poolX: -38.4 },
]));
export const PARKING_LIGHT_HEIGHT = 4.5;
export interface ParkedVehicle { id: string; model: MobilityModel; x: number; y: number; z: number; yaw: number; tone: string }
export const PARKING_BAYS = Object.freeze([-10.2, -7, -3.8, -.6, 2.6, 5.8, 9, 12.2, 15.4].flatMap((z, index) => ([-1, 1] as const).map(side => ({
  id: `parking-${side}-${index}`, x: side < 0 ? -47.25 : -37.75, z, yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2,
  ev: side < 0 && index >= 6, occupied: (index + (side > 0 ? 2 : 0)) % 3 !== 1,
}))));
const TONES = ['#a3bec5', '#e5e1d7', '#507b88', '#9c6552', '#747a86'];
let parkedStyle = 0;
export const PARKED_VEHICLES: readonly ParkedVehicle[] = Object.freeze(PARKING_BAYS.filter(bay => bay.occupied).map((bay, index) => ({
  id: bay.id, model: bay.ev ? 'mobility-ev' : VEHICLE_MODELS[(parkedStyle++) % 7]!, x: bay.x, y: PARKING.top + .015, z: bay.z, yaw: bay.yaw, tone: TONES[index % TONES.length]!,
})));
export const EV_CHARGERS: readonly ParkedVehicle[] = Object.freeze(PARKING_BAYS.filter(bay => bay.ev).map(bay => ({id: `charger-${bay.id}`, model: 'mobility-charger' as const, x: -50.45, y: PARKING.top + .015, z: bay.z, yaw: Math.PI / 2, tone: '#ffffff'})));
export const CYCLE_SHELTER: ParkedVehicle = {id: 'cycle-shelter', model: 'mobility-cycle-shelter', x: 20, y: -.24, z: -25, yaw: 0, tone: '#ffffff'};
export interface TrafficLane { id: string; model: MobilityModel; from: readonly [number, number]; to: readonly [number, number]; top: number; speed: number; period: number; offset: number; crossing: boolean; tone: string }
/** Sparse straight through-lanes stay outside pedestrian paths and never turn through a junction. */
export const TRAFFIC_LANES: readonly TrafficLane[] = [
  {id:'front-eastbound',model:'mobility-ev',from:[-51,FRONT_APPROACH.roadCenterZ-1.65],to:[51,FRONT_APPROACH.roadCenterZ-1.65],top:FRONT_APPROACH.roadTop,speed:7.5,period:49,offset:0,crossing:true,tone:'#d8e5dd'},
  {id:'front-westbound',model:'mobility-sedan',from:[51,FRONT_APPROACH.roadCenterZ+1.65],to:[-51,FRONT_APPROACH.roadCenterZ+1.65],top:FRONT_APPROACH.roadTop,speed:6.8,period:57,offset:19,crossing:true,tone:'#748d9a'},
  {id:'west-northbound',model:'mobility-mpv',from:[-58.35,-47],to:[-58.35,74],top:FRONT_APPROACH.roadTop,speed:8,period:63,offset:33,crossing:false,tone:'#c6c2b6'},
  {id:'east-southbound',model:'mobility-suv',from:[61.65,74],to:[61.65,-47],top:FRONT_APPROACH.roadTop,speed:8.5,period:53,offset:9,crossing:false,tone:'#527d7d'},
];
export function trafficPose(lane: TrafficLane, seconds: number, reducedMotion = false) {
  const dx=lane.to[0]-lane.from[0], dz=lane.to[1]-lane.from[1], length=Math.hypot(dx,dz);
  const time=((Math.max(0,seconds)+lane.offset)%lane.period+lane.period)%lane.period;
  const stopDistance=length/2-5.8, stopAt=stopDistance/lane.speed, wait=lane.crossing?3.2:0;
  const travelled=lane.crossing&&time>=stopAt ? stopDistance+Math.max(0,time-stopAt-wait)*lane.speed : time*lane.speed;
  const t=Math.min(1,travelled/length);
  return {visible:!reducedMotion&&time<length/lane.speed+wait,x:lane.from[0]+dx*t,y:lane.top+.015,z:lane.from[1]+dz*t,yaw:Math.atan2(dx,dz),stopped:lane.crossing&&time>=stopAt&&time<stopAt+wait};
}
