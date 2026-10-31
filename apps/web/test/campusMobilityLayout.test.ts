import {describe,expect,it} from 'vitest';
import {EV_CHARGERS,DERIVED_VEHICLE_MODELS,DAILY_CATALOG,DAILY_STYLE_RANGE,FORCED_THEME_DENSITY,GENERATED_MOBILITY_MODELS,LEGACY_MOBILITY_MODELS,MOBILITY_MODELS,OPEN_LANES,PICKUPS,TRAFFIC_LANES,TRAFFIC_SCHEDULE,TRAFFIC_TIMING,VEHICLE_CATALOG,VEHICLE_SPECS,admitTraffic,carActive,createTrafficPose,dailySeed,dailyStyles,laneCaps,laneLength,licensedCatalog,parkingAssignment,resolveMobilityModel,trafficDensity,trafficInstanceCounts,trafficSchedule,truckStandIn,updateTraffic,vehicleCategory,isMobilityVehicle,PARKED_VEHICLES,PARKING,PARKING_BAYS,type CatalogVehicle,type LaneSchedule,type MobilityModel,type TrafficCarPose} from '../src/office/scene/campusMobilityLayout';
import {MAX_TRAFFIC_CARS,TRAFFIC_INSTANCES,trafficCarCap,trafficDensityFor} from '../src/office/scene/CampusTraffic';
import {RENDER_BUDGET_LEVELS} from '../src/office/scene/environment/renderBudget';
import {parkingSlabs} from '../src/office/scene/CampusParking';

describe('campus mobility and pedestrian separation',()=>{
  it('keeps every parked body inside its bay with space between rows and the separate footway',()=>{
    expect(PARKING_BAYS).toHaveLength(18);
    // West lot here; both lots' bodies are checked against their own lot in campusParkingLots.test.ts.
    for(const car of PARKED_VEHICLES.filter(vehicle=>PARKING_BAYS.some(bay=>bay.id===vehicle.id))){
      if (!isMobilityVehicle(car.model)) throw new Error('Parking requires a vehicle');
      const length = VEHICLE_SPECS[car.model]!.length + (car.model === 'mobility-jeep' ? .36 : .14);
      const halfWidth = (VEHICLE_SPECS[car.model]!.width + .16) / 2;
      expect(car.x-length/2).toBeGreaterThan(PARKING.west);
      expect(car.x+length/2).toBeLessThan(PARKING.east);
      expect(Math.abs(car.x-PARKING.aisleX)).toBeGreaterThan(4.5);
      expect(car.z-halfWidth).toBeGreaterThan(PARKING.north);
      expect(car.z+halfWidth).toBeLessThan(PARKING.south);
    }
    expect(PARKING.footwayX-1).toBeGreaterThan(PARKING.east);
    expect(parkingSlabs().every(s=>s.w>0&&s.d>0&&s.h>0)).toBe(true);
  });
  it('parks electric cars at the chargers, shows rare styles at most once and mixes both categories in traffic on every day',()=>{
    const occupied=PARKING_BAYS.filter(bay=>bay.occupied);
    const byModel=new Map(VEHICLE_CATALOG.map(vehicle=>[vehicle.model,vehicle]));
    for(let day=0;day<120;day++){
      const seed=dailySeed(new Date(2026,9,1+day)),styles=dailyStyles(seed);
      const parked=parkingAssignment(occupied,styles),schedule=trafficSchedule(seed,styles);
      const lanes=schedule.flatMap(lane=>lane.cars.map(car=>car.model));
      parked.forEach((model,index)=>{if(occupied[index]!.ev)expect(vehicleCategory(model)).toBe('ev');expect(byModel.get(model)?.trafficOnly).not.toBe(true);});
      for(const vehicle of styles.filter(vehicle=>vehicle.weight<1&&!vehicle.trafficOnly)){
        expect(parked.filter(model=>model===vehicle.model).length).toBeLessThanOrEqual(1);
        expect(lanes).not.toContain(vehicle.model);
      }
      expect(schedule).toHaveLength(TRAFFIC_LANES.length);
      expect(new Set(lanes.map(model=>vehicleCategory(model)))).toEqual(new Set(['ev','conventional']));
      schedule.forEach((lane,index)=>lane.cars.forEach(car=>{if(byModel.get(car.model)!.trafficOnly)expect(OPEN_LANES).toContain(index);}));
      // Only the day's styles are parked, driven and loaded; every day parks a derived pickup (the retired truck's place).
      for(const model of [...parked,...lanes])expect(styles.map(vehicle=>vehicle.model)).toContain(model);
      expect(parked.some(model=>PICKUPS.includes(model))).toBe(true);
    }
    expect(resolveMobilityModel('mobility-suv')).toBe('mobility-ev-suv');
    expect(resolveMobilityModel('mobility-ev')).toBe('mobility-ev-sedan-long');
    expect(resolveMobilityModel('mobility-double-cabin')).toBe('mobility-pickup');
    expect(VEHICLE_CATALOG.find(vehicle=>vehicle.style==='pickup')).toMatchObject({category:'conventional',weight:1});
    expect(resolveMobilityModel('mobility-unknown')).toBeUndefined();
    for(const lane of TRAFFIC_SCHEDULE)for(const car of lane.cars)expect(DERIVED_VEHICLE_MODELS).toContain(car.model);
    expect(new Set(PARKED_VEHICLES.map(car=>car.model)).size).toBeGreaterThan(6);
  });
  it('rotates 12 to 14 styles a day, deterministically by local date, and every style comes round',()=>{
    const seen=new Set<string>(),sizes=new Set<number>();
    for(let day=0;day<90;day++){
      const date=new Date(2026,10,1+day),seed=dailySeed(date),styles=dailyStyles(seed);
      expect(dailyStyles(seed)).toEqual(styles);
      expect(styles.length).toBeGreaterThanOrEqual(DAILY_STYLE_RANGE.min);expect(styles.length).toBeLessThanOrEqual(DAILY_STYLE_RANGE.max);
      expect(styles.filter(vehicle=>vehicle.category==='ev'&&!vehicle.trafficOnly).length).toBeGreaterThanOrEqual(DAILY_STYLE_RANGE.ev);
      sizes.add(styles.length);styles.forEach(vehicle=>seen.add(vehicle.style));
    }
    expect(dailySeed(new Date(2026,9,29,23,59))).toBe(20261029);
    expect(sizes).toEqual(new Set([12,13,14]));
    expect(seen).toEqual(new Set(VEHICLE_CATALOG.map(vehicle=>vehicle.style)));
    expect(DAILY_CATALOG.length).toBeGreaterThanOrEqual(DAILY_STYLE_RANGE.min);
    // Common styles show up far more often than rare ones.
    const count=(style:string)=>Array.from({length:365},(_,day)=>dailyStyles(dailySeed(new Date(2026,0,1+day)))).filter(list=>list.some(vehicle=>vehicle.style===style)).length;
    expect(count('estate')).toBeGreaterThan(2*count('hypercar'));
  });
  it('keeps non-commercial and unverified cars one switch away from parking and traffic',()=>{
    const restricted=VEHICLE_CATALOG.filter(vehicle=>vehicle.nonCommercial||vehicle.licenseUnverified);
    expect(restricted.length).toBeGreaterThan(0);
    expect(licensedCatalog(VEHICLE_CATALOG,false)).toHaveLength(VEHICLE_CATALOG.length);
    const commercial=licensedCatalog(VEHICLE_CATALOG,true);
    expect(commercial.some(vehicle=>vehicle.nonCommercial||vehicle.licenseUnverified)).toBe(false);
    for(let day=0;day<60;day++){
      const styles=dailyStyles(dailySeed(new Date(2026,9,1+day)),commercial);
      const used=[...parkingAssignment(PARKING_BAYS.filter(bay=>bay.occupied),styles),...trafficSchedule(day,styles).flatMap(lane=>lane.cars.map(car=>car.model))];
      for(const vehicle of restricted)expect(used).not.toContain(vehicle.model);
    }
  });
  it('keeps the mix data-driven: a new catalog car joins parking and traffic by category and weight',()=>{
    const spec={length:4.5,width:1.9,height:1.5,wheel:.33,wheelbase:2.8,track:1.6};
    const catalog:CatalogVehicle[]=[...VEHICLE_CATALOG,{style:'ev-hatch',model:'mobility-ev-hatch' as const,category:'ev' as const,weight:5,spec}];
    const bays=[{ev:true},{ev:false},{ev:false}];
    expect(parkingAssignment(bays,catalog)[0]).toBe('mobility-ev-hatch');
    expect(trafficSchedule(1,catalog).flatMap(lane=>lane.cars.map(car=>car.model))).toContain('mobility-ev-hatch');
    const assigned=parkingAssignment(Array.from({length:60},(_,i)=>({ev:i<3})),catalog);
    expect(assigned.filter(model=>model==='mobility-sports')).toHaveLength(1);
    expect(new Set(assigned)).toEqual(new Set(catalog.filter(vehicle=>!vehicle.trafficOnly).map(vehicle=>vehicle.model)));
  });
  it('assigns three west EV bays a separate charger without blocking the drive aisle',()=>{
    expect(EV_CHARGERS).toHaveLength(6);
    for(const charger of EV_CHARGERS.filter(entry=>entry.x<0)){
      expect(charger.x+.4).toBeLessThan(-49.55);
      expect(PARKING_BAYS.some(b=>b.ev&&b.z===charger.z)).toBe(true);
    }
  });
  const allAdmitted=(schedules:readonly LaneSchedule[])=>schedules.map(lane=>new Uint8Array(lane.cars.length).fill(1));
  /** Steps the traffic over `seconds` and hands every frame's active cars to `check`. */
  function simulate(schedules:readonly LaneSchedule[],admitted:Uint8Array[],density:number,seconds:number,check:(cars:TrafficCarPose[],t:number)=>void,dt=.05,start=0){
    const pool=Array.from({length:64},createTrafficPose);
    for(let t=start;t<start+seconds;t+=dt){const count=updateTraffic(schedules,admitted,t,density,pool);check(pool.slice(0,count),t);}
  }
  const horizon=Math.max(...TRAFFIC_TIMING.cycle);
  const seeds=[20261030,20261111,20270214,7];

  it('runs straight lanes outside pedestrian paths and junctions, both avenues both ways, keeping to the left',()=>{
    expect(TRAFFIC_LANES).toHaveLength(6);
    expect(OPEN_LANES).toEqual([2,3,4,5]);
    for(const lane of TRAFFIC_LANES){
      // Axis-aligned, within one road between the junctions at z=-60/84 and x=±60 (their crosswalks reach 5.3 ± 1.2 m out).
      expect(lane.from[0]===lane.to[0]||lane.from[1]===lane.to[1]).toBe(true);
      if(lane.from[1]===lane.to[1]){expect(Math.max(Math.abs(lane.from[0]),Math.abs(lane.to[0]))).toBeLessThanOrEqual(60-5.3-1.2-2.5);expect(Math.abs(lane.from[1]+60)).toBeCloseTo(1.65);}
      else{expect(Math.abs(Math.abs(lane.from[0])-60)).toBeCloseTo(1.65);expect(Math.min(lane.from[1],lane.to[1])).toBeGreaterThanOrEqual(-60+6.5+3);expect(Math.max(lane.from[1],lane.to[1])).toBeLessThanOrEqual(84-6.5-3);}
      // Left-hand traffic: the lane centre lies on the driver's left of the road centreline.
      const dx=Math.sign(lane.to[0]-lane.from[0]),dz=Math.sign(lane.to[1]-lane.from[1]);
      const offset=lane.from[1]===lane.to[1]?[0,lane.from[1]+60]:[lane.from[0]-Math.sign(lane.from[0])*60,0];
      expect(offset[0]!*-dz+offset[1]!*dx).toBeLessThan(0);
      expect(lane.crossing).toBe(lane.from[1]===lane.to[1]);
    }
  });
  it('schedules deterministic waves per lane from the day seed: 1–3 cars 2.2–4 s apart, then 10–30 s quiet',()=>{
    for(const seed of seeds){
      const schedule=trafficSchedule(seed,dailyStyles(seed));
      expect(trafficSchedule(seed,dailyStyles(seed))).toEqual(schedule);
      expect(trafficSchedule(seed+1,dailyStyles(seed))).not.toEqual(schedule);
      for(const lane of schedule){
        expect(lane.cycle).toBeGreaterThanOrEqual(TRAFFIC_TIMING.cycle[0]);expect(lane.cycle).toBeLessThanOrEqual(TRAFFIC_TIMING.cycle[1]);
        expect(lane.cars.length).toBeGreaterThan(8);
        // A quiet tail at least one lane window long separates cycles.
        expect(lane.cars.at(-1)!.depart).toBeLessThanOrEqual(lane.cycle-lane.window-1);
        const groups=new Map<number,number[]>();
        lane.cars.forEach((car,index)=>{
          expect(car.id).toBe(lane.index*1000+index);
          if(index)expect(car.depart).toBeGreaterThan(lane.cars[index-1]!.depart);
          groups.set(car.group,[...(groups.get(car.group)??[]),car.depart]);
          expect(car.lead).toBe(index===0||lane.cars[index-1]!.group!==car.group);
        });
        const list=[...groups.values()];
        list.forEach((departs,g)=>{
          expect(departs.length).toBeGreaterThanOrEqual(1);expect(departs.length).toBeLessThanOrEqual(3);
          departs.slice(1).forEach((depart,k)=>{expect(depart-departs[k]!).toBeGreaterThanOrEqual(TRAFFIC_TIMING.headway[0]);expect(depart-departs[k]!).toBeLessThanOrEqual(TRAFFIC_TIMING.headway[1]);});
          if(g)expect(departs[0]!-list[g-1]!.at(-1)!).toBeGreaterThanOrEqual(TRAFFIC_TIMING.gap[0]);
          if(g)expect(departs[0]!-list[g-1]!.at(-1)!).toBeLessThanOrEqual(TRAFFIC_TIMING.gap[1]);
        });
        expect(new Set(list.map(departs=>departs.length)).size).toBeGreaterThan(1);
      }
      // Traffic-only vehicles stay rare and on open lanes; only the day's common styles drive.
      const styles=dailyStyles(seed),models=new Set(styles.filter(vehicle=>vehicle.weight>=1||vehicle.trafficOnly).map(vehicle=>vehicle.model));
      const cars=schedule.flatMap(lane=>lane.cars);
      for(const car of cars)expect(models.has(car.model)).toBe(true);
      const long=cars.filter(car=>VEHICLE_CATALOG.find(vehicle=>vehicle.model===car.model)!.trafficOnly);
      expect(long.length).toBeLessThanOrEqual(Math.ceil(cars.length*.12));
    }
    expect(TRAFFIC_SCHEDULE.map(lane=>lane.lane.id)).toEqual(TRAFFIC_LANES.map(lane=>lane.id));
  });
  it('keeps every car on its lane with at least the clearance to the car ahead, without jumps, and off the road within its window',()=>{
    for(const seed of seeds.slice(0,3)){
      const schedule=trafficSchedule(seed),admitted=allAdmitted(schedule);
      const last=new Map<number,{x:number;z:number;t:number;distance:number}>();
      let most=0;
      simulate(schedule,admitted,1,horizon,(cars,t)=>{
        most=Math.max(most,cars.length);
        for(const lane of schedule){
          const onLane=cars.filter(car=>car.lane===lane.index).sort((a,b)=>b.distance-a.distance);
          onLane.forEach((car,index)=>{
            const spec=lane.cars.find(entry=>entry.id===car.id)!;
            expect(car.distance).toBeGreaterThanOrEqual(0);expect(car.distance).toBeLessThanOrEqual(laneLength(lane.lane)+1e-9);
            // On the road only within its lane window after departure.
            const local=((t+lane.phase)%lane.cycle+lane.cycle)%lane.cycle;
            expect(local-spec.depart).toBeLessThanOrEqual(lane.window);
            if(index){
              const ahead=onLane[index-1]!,aheadSpec=lane.cars.find(entry=>entry.id===ahead.id)!;
              expect(ahead.distance-car.distance).toBeGreaterThanOrEqual(aheadSpec.half+spec.half+TRAFFIC_TIMING.clearance-1e-6);
            }
            const before=last.get(car.id);
            if(before&&t-before.t<.06){
              expect(Math.hypot(car.x-before.x,car.z-before.z)).toBeLessThanOrEqual(lane.lane.speed*.0501);
              expect(car.distance).toBeGreaterThanOrEqual(before.distance-1e-9);
            }
            last.set(car.id,{x:car.x,z:car.z,t,distance:car.distance});
          });
        }
      });
      expect(most).toBeGreaterThan(6);
    }
  });
  it('stops at the crossing before the stop line and queues followers behind a waiting car with brakes on',()=>{
    let queued=0;
    for(const seed of seeds){
      const schedule=trafficSchedule(seed);
      simulate(schedule,allAdmitted(schedule),1,horizon,cars=>{
        for(const lane of schedule.filter(entry=>entry.lane.crossing)){
          const length=laneLength(lane.lane);
          const onLane=cars.filter(car=>car.lane===lane.index).sort((a,b)=>b.distance-a.distance);
          onLane.forEach((car,index)=>{
            const half=lane.cars.find(entry=>entry.id===car.id)!.half;
            // Waiting cars keep their front bumper before the stop line.
            if(car.stopped)expect(car.distance+half).toBeLessThanOrEqual(length/2-TRAFFIC_TIMING.stopLine+1e-6);
            const ahead=onLane[index-1];
            if(car.stopped&&ahead?.stopped&&car.distance+half<length/2-TRAFFIC_TIMING.stopLine-.5){
              const aheadHalf=lane.cars.find(entry=>entry.id===ahead.id)!.half;
              expect(ahead.distance-aheadHalf-(car.distance+half)).toBeCloseTo(TRAFFIC_TIMING.clearance,5);
              queued++;
            }
          });
        }
        for(const lane of schedule.filter(entry=>!entry.lane.crossing))for(const car of cars)if(car.lane===lane.index)expect(car.stopped).toBe(false);
      });
    }
    expect(queued).toBeGreaterThan(20);
  });
  it('is busiest in the morning and evening rush, calmer by day and quiet but never empty at night',()=>{
    expect(trafficDensity(8*60)).toBe(1);expect(trafficDensity(18*60)).toBe(1);
    expect(trafficDensity(13*60)).toBeCloseTo(.6);expect(trafficDensity(3*60)).toBeCloseTo(.3);
    expect(trafficDensity(-60)).toBeCloseTo(trafficDensity(23*60));
    for(let minute=0;minute<1440;minute+=15){expect(trafficDensity(minute)).toBeGreaterThanOrEqual(.3);expect(trafficDensity(minute)).toBeLessThanOrEqual(1);}
    expect(trafficDensityFor('day',3*60)).toBe(FORCED_THEME_DENSITY.day);expect(trafficDensityFor('night',8*60)).toBe(FORCED_THEME_DENSITY.night);
    expect(trafficDensityFor('sun',8*60)).toBe(1);
    expect(carActive({lead:true,groupRank:.99,rank:0},1)).toBe(true);
    expect(carActive({lead:false,groupRank:.2,rank:.6},.3)).toBe(false);
    const carSeconds=(minutes:number)=>{let total=0;const schedule=trafficSchedule(seeds[0]!),admitted=admitTraffic(schedule,trafficCarCap(0));simulate(schedule,admitted,trafficDensity(minutes),horizon*2,cars=>{total+=cars.length;},.25);return total;};
    const rush=carSeconds(8*60),midday=carSeconds(13*60),night=carSeconds(2*60);
    expect(rush).toBeGreaterThan(midday);expect(midday).toBeGreaterThan(night);expect(night).toBeGreaterThan(rush*.1);
  });
  it('caps moving cars per render tier (fewer on lower tiers) and sizes each model batch for its peak',()=>{
    expect(RENDER_BUDGET_LEVELS.map(level=>level.trafficCars)).toEqual([16,14,10,6]);
    expect(MAX_TRAFFIC_CARS).toBe(16);
    expect(trafficCarCap(99)).toBe(6);expect(trafficCarCap(-1)).toBe(16);
    expect(laneCaps(16)).toEqual([3,3,3,3,2,2]);expect(laneCaps(6)).toEqual([1,1,1,1,1,1]);
    for(const seed of seeds.slice(0,2)){
      const schedule=trafficSchedule(seed),bounds=trafficInstanceCounts(schedule,MAX_TRAFFIC_CARS);
      let previous=Infinity;
      RENDER_BUDGET_LEVELS.forEach((_,level)=>{
        const cap=trafficCarCap(level),caps=laneCaps(cap),admitted=admitTraffic(schedule,cap);
        let most=0;
        simulate(schedule,admitted,1,horizon,cars=>{
          most=Math.max(most,cars.length);
          expect(cars.length).toBeLessThanOrEqual(cap);
          caps.forEach((laneCap,lane)=>expect(cars.filter(car=>car.lane===lane).length).toBeLessThanOrEqual(laneCap));
          const perModel=new Map<MobilityModel,number>();
          for(const car of cars)perModel.set(car.model,(perModel.get(car.model)??0)+1);
          perModel.forEach((count,model)=>expect(count).toBeLessThanOrEqual(bounds.get(model)!));
        },.1);
        expect(most).toBeLessThanOrEqual(previous);previous=most;
      });
    }
    for(const [model,count] of TRAFFIC_INSTANCES){expect(count).toBeGreaterThan(0);expect(count).toBeLessThanOrEqual(MAX_TRAFFIC_CARS);expect(DAILY_CATALOG.map(vehicle=>vehicle.model)).toContain(model);}
    // Reduced motion keeps the roads empty.
    expect(updateTraffic(TRAFFIC_SCHEDULE,admitTraffic(TRAFFIC_SCHEDULE,16),100,1,Array.from({length:16},createTrafficPose),true)).toBe(0);
  });
  it('retires the procedural single-cab truck: its name resolves to the day’s derived pickup',()=>{
    expect(MOBILITY_MODELS).not.toContain('mobility-truck');
    expect(GENERATED_MOBILITY_MODELS).toEqual(['mobility-charger','mobility-cycle-shelter']);
    expect(PICKUPS).toEqual(expect.arrayContaining(['mobility-pickup','mobility-pickup-midsize','mobility-pickup-large','mobility-pickup-offroad']));
    expect(PICKUPS.every(model=>isMobilityVehicle(model)&&VEHICLE_SPECS[model]!.cargo)).toBe(true);
    const byStyle=(...styles:string[])=>VEHICLE_CATALOG.filter(vehicle=>styles.includes(vehicle.style));
    expect(truckStandIn(byStyle('sedan','pickup-midsize','pickup'))).toBe('mobility-pickup-midsize');
    expect(truckStandIn(byStyle('sedan','pickup','pickup-large'))).toBe('mobility-pickup');
    expect(truckStandIn(byStyle('sedan','pickup-large'))).toBe('mobility-pickup-large');
    expect(truckStandIn(byStyle('sedan'))).toBe('mobility-pickup');
    expect(LEGACY_MOBILITY_MODELS['mobility-truck']).toBe(truckStandIn(DAILY_CATALOG));
    expect(resolveMobilityModel('mobility-truck')).toBe(truckStandIn(DAILY_CATALOG));
    for(let day=0;day<60;day++){
      const styles=dailyStyles(dailySeed(new Date(2026,10,1+day)));
      expect(styles.some(vehicle=>PICKUPS.includes(vehicle.model))).toBe(true);
      expect(styles.map(vehicle=>vehicle.model)).toContain(truckStandIn(styles));
    }
  });
});
