import {describe,expect,it} from 'vitest';
import {EV_CHARGERS,VEHICLE_SPECS,isMobilityVehicle,PARKED_VEHICLES,PARKING,PARKING_BAYS,TRAFFIC_LANES,trafficPose} from '../src/office/scene/campusMobilityLayout';
import {parkingSlabs} from '../src/office/scene/CampusParking';

describe('campus mobility and pedestrian separation',()=>{
  it('keeps every parked body inside its bay with space between rows and the separate footway',()=>{
    expect(PARKING_BAYS).toHaveLength(18);
    for(const car of PARKED_VEHICLES){
      if (!isMobilityVehicle(car.model)) throw new Error('Parking requires a vehicle');
      const length = VEHICLE_SPECS[car.model].length + (car.model === 'mobility-jeep' ? .36 : .14);
      const halfWidth = (VEHICLE_SPECS[car.model].width + .16) / 2;
      expect(car.x-length/2).toBeGreaterThan(PARKING.west);
      expect(car.x+length/2).toBeLessThan(PARKING.east);
      expect(Math.abs(car.x-PARKING.aisleX)).toBeGreaterThan(4.5);
      expect(car.z-halfWidth).toBeGreaterThan(PARKING.north);
      expect(car.z+halfWidth).toBeLessThan(PARKING.south);
    }
    expect(PARKING.footwayX-1).toBeGreaterThan(PARKING.east);
    expect(parkingSlabs().every(s=>s.w>0&&s.d>0&&s.h>0)).toBe(true);
  });
  it('assigns three EV bays a separate charger without blocking the drive aisle',()=>{
    expect(EV_CHARGERS).toHaveLength(3);
    for(const charger of EV_CHARGERS){
      expect(charger.x+.4).toBeLessThan(-49.55);
      expect(PARKING_BAYS.some(b=>b.ev&&b.z===charger.z)).toBe(true);
    }
  });
  it('keeps occasional vehicles on their road lane, pauses before the crossing and respects reduced motion',()=>{
    for(const lane of TRAFFIC_LANES){
      let stopped=0,visible=0;
      for(let i=0;i<lane.period*20;i++){
        const pose=trafficPose(lane,i/20);
        if(!pose.visible)continue;visible++;if(pose.stopped)stopped++;
        expect(pose.x).toBeGreaterThanOrEqual(Math.min(lane.from[0],lane.to[0]));
        expect(pose.x).toBeLessThanOrEqual(Math.max(lane.from[0],lane.to[0]));
        expect(pose.z).toBeGreaterThanOrEqual(Math.min(lane.from[1],lane.to[1]));
        expect(pose.z).toBeLessThanOrEqual(Math.max(lane.from[1],lane.to[1]));
        if(pose.stopped)expect(Math.abs(pose.x)).toBeGreaterThan(5.7);
        expect(trafficPose(lane,i/20,true).visible).toBe(false);
      }
      expect(visible).toBeLessThan(lane.period*12);
      expect(stopped>0).toBe(lane.crossing);
    }
  });
  it('does not jump position when stopping or resuming at the crossing',()=>{
    for(const lane of TRAFFIC_LANES){
      for(let t=.01;t<lane.period;t+=.05){
        const a=trafficPose(lane,t-.01),b=trafficPose(lane,t);
        if(!a.visible||!b.visible)continue;
        expect(Math.hypot(b.x-a.x,b.z-a.z)).toBeLessThanOrEqual(lane.speed*.01001);
      }
    }
  });
});
