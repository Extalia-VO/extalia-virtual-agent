import {describe,expect,it} from 'vitest';
import {EV_CHARGERS,DERIVED_VEHICLE_MODELS,DAILY_CATALOG,DAILY_STYLE_RANGE,FORCED_THEME_DENSITY,GENERATED_MOBILITY_MODELS,LEGACY_MOBILITY_MODELS,MOBILITY_MODELS,PICKUPS,TRAFFIC_LANES,VEHICLE_CATALOG,VEHICLE_SPECS,carActive,dailySeed,dailyStyles,licensedCatalog,parkingAssignment,resolveMobilityModel,trafficDensity,trafficPool,truckStandIn,vehicleCategory,isMobilityVehicle,PARKED_VEHICLES,PARKING,PARKING_BAYS,type CatalogVehicle,type MobilityModel} from '../src/office/scene/campusMobilityLayout';
import {ROAD_NETWORK,LANE_OFFSET} from '../src/office/scene/campusRoadNetwork';
import {advanceTrafficNetwork,createTrafficNetwork,stepTrafficNetwork,trafficModelSlots,type TrafficNetwork,type TrafficStepInput} from '../src/office/scene/trafficNetwork';
import {MAX_TRAFFIC_CARS,MAX_LOT_CARS,TRAFFIC_INSTANCES,trafficCarCap,trafficDensityFor} from '../src/office/scene/CampusTraffic';
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
      const parked=parkingAssignment(occupied,styles),pool=trafficPool(styles);
      const lanes=[...pool.cars,...pool.long].map(vehicle=>vehicle.model);
      parked.forEach((model,index)=>{if(occupied[index]!.ev)expect(vehicleCategory(model)).toBe('ev');expect(byModel.get(model)?.trafficOnly).not.toBe(true);});
      for(const vehicle of styles.filter(vehicle=>vehicle.weight<1&&!vehicle.trafficOnly)){
        expect(parked.filter(model=>model===vehicle.model).length).toBeLessThanOrEqual(1);
        expect(lanes).not.toContain(vehicle.model);
      }
      expect(new Set(lanes.map(model=>vehicleCategory(model)))).toEqual(new Set(['ev','conventional']));
      // Traffic-only (long) vehicles are a separate pool of their own; the common pool never holds them.
      pool.cars.forEach(vehicle=>expect(vehicle.trafficOnly).not.toBe(true));pool.long.forEach(vehicle=>expect(vehicle.trafficOnly).toBe(true));
      // Only the day's styles are parked, driven and loaded; every day parks a derived pickup (the retired truck's place).
      for(const model of [...parked,...lanes])expect(styles.map(vehicle=>vehicle.model)).toContain(model);
      expect(parked.some(model=>PICKUPS.includes(model))).toBe(true);
    }
    expect(resolveMobilityModel('mobility-suv')).toBe('mobility-ev-suv');
    expect(resolveMobilityModel('mobility-ev')).toBe('mobility-ev-sedan-long');
    expect(resolveMobilityModel('mobility-double-cabin')).toBe('mobility-pickup');
    expect(VEHICLE_CATALOG.find(vehicle=>vehicle.style==='pickup')).toMatchObject({category:'conventional',weight:1});
    expect(resolveMobilityModel('mobility-unknown')).toBeUndefined();
    for(const vehicle of [...trafficPool(DAILY_CATALOG).cars,...trafficPool(DAILY_CATALOG).long])expect(DERIVED_VEHICLE_MODELS).toContain(vehicle.model);
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
      const used=[...parkingAssignment(PARKING_BAYS.filter(bay=>bay.occupied),styles),...trafficPool(styles).cars.map(vehicle=>vehicle.model),...trafficPool(styles).long.map(vehicle=>vehicle.model)];
      for(const vehicle of restricted)expect(used).not.toContain(vehicle.model);
    }
  });
  it('keeps the mix data-driven: a new catalog car joins parking and traffic by category and weight',()=>{
    const spec={length:4.5,width:1.9,height:1.5,wheel:.33,wheelbase:2.8,track:1.6};
    const catalog:CatalogVehicle[]=[...VEHICLE_CATALOG,{style:'ev-hatch',model:'mobility-ev-hatch' as const,category:'ev' as const,weight:5,spec}];
    const bays=[{ev:true},{ev:false},{ev:false}];
    expect(parkingAssignment(bays,catalog)[0]).toBe('mobility-ev-hatch');
    expect(trafficPool(catalog).cars.map(vehicle=>vehicle.model)).toContain('mobility-ev-hatch');
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
  const seeds=[20261030,20261111,20270214,7];
  const full:TrafficStepInput={density:1,cap:16,headroom:4};
  /** Steps a network and hands every step's moving cars to `check`. */
  function simulate(net:TrafficNetwork,input:TrafficStepInput,seconds:number,check:(net:TrafficNetwork)=>void,dt=.1){
    for(let t=0;t<seconds;t+=dt){stepTrafficNetwork(net,dt,input);check(net);}
  }

  it('drives on the left of every street, both ways, and keeps the zebra crossing on the front road only',()=>{
    expect(TRAFFIC_LANES).toBe(ROAD_NETWORK.lanes);
    for(const lane of TRAFFIC_LANES){
      // Axis-aligned, and the lane centre lies on the driver's left of the street's centreline.
      expect(lane.from[0]===lane.to[0]||lane.from[1]===lane.to[1]).toBe(true);
      const opposite=TRAFFIC_LANES[lane.reverse]!;
      expect(opposite.reverse).toBe(lane.index);
      expect(opposite.length).toBeCloseTo(lane.length);
      const across=lane.from[1]===lane.to[1]?lane.from[1]-opposite.from[1]:lane.from[0]-opposite.from[0];
      expect(Math.abs(across)).toBeCloseTo(2*LANE_OFFSET);
      const side=lane.dx*(lane.from[1]-opposite.from[1])-lane.dz*(lane.from[0]-opposite.from[0]);
      expect(side).toBeLessThan(0);
      if(lane.crossing)expect(lane.road).toBe('front');
    }
    expect(TRAFFIC_LANES.some(lane=>lane.crossing)).toBe(true);
  });
  it('platoons are deterministic per day seed and the day’s styles; only common styles drive and long ones are rare',()=>{
    for(const seed of seeds){
      const styles=dailyStyles(seed),run=(value:number)=>{const net=createTrafficNetwork(value,styles);advanceTrafficNetwork(net,90,full);return net.poses.slice(0,net.count).map(pose=>[pose.id,pose.model,+pose.x.toFixed(6),+pose.z.toFixed(6)]);};
      expect(run(seed)).toEqual(run(seed));
      expect(run(seed+1)).not.toEqual(run(seed));
      // Traffic-only vehicles stay rare; only the day's common styles drive.
      const pool=trafficPool(styles),common=new Set(pool.cars.map(vehicle=>vehicle.model)),long=new Set(pool.long.map(vehicle=>vehicle.model));
      const net=createTrafficNetwork(seed,styles);
      const seen=new Set<number>();let cars=0,longCars=0;
      simulate(net,full,240,network=>{
        for(const car of network.cars)if(car.active&&!seen.has(car.id)){
          seen.add(car.id);cars++;
          expect(common.has(car.model)||long.has(car.model)).toBe(true);
          if(long.has(car.model)){longCars++;expect(car.long).toBe(true);}
        }
      });
      expect(cars).toBeGreaterThan(20);
      expect(longCars).toBeLessThanOrEqual(Math.ceil(cars*.15));
    }
  });
  it('keeps long vehicles on straight routes that never use the zebra crossing',()=>{
    let longRoutes=0;
    const styles=VEHICLE_CATALOG.filter(vehicle=>vehicle.weight>=1||vehicle.trafficOnly);
    expect(trafficPool(styles).long.length).toBeGreaterThan(0);
    for(const seed of seeds.slice(0,2)){
      const net=createTrafficNetwork(seed,styles);
      const checked=new Set<number>();
      simulate(net,full,1800,network=>{
        for(const car of network.cars)if(car.active&&car.long&&!checked.has(car.id)){
          checked.add(car.id);longRoutes++;
          for(let i=0;i<car.length;i++){
            const segment=car.route[i]!;
            if(segment<ROAD_NETWORK.lanes.length)expect(ROAD_NETWORK.lanes[segment]!.crossing).toBe(false);
            else expect(ROAD_NETWORK.turns[segment-ROAD_NETWORK.lanes.length]!.kind).toBe('straight');
          }
        }
      },.25);
    }
    expect(longRoutes).toBeGreaterThan(0);
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
    const carSeconds=(minutes:number)=>{let total=0;const net=createTrafficNetwork(seeds[0]!);const input={density:trafficDensity(minutes),cap:16,headroom:4};advanceTrafficNetwork(net,60,input);simulate(net,input,600,network=>{total+=network.count;},.25);return total;};
    const rush=carSeconds(8*60),midday=carSeconds(13*60),night=carSeconds(2*60);
    expect(rush).toBeGreaterThan(midday);expect(midday).toBeGreaterThan(night);expect(night).toBeGreaterThan(rush*.1);
  });
  it('caps moving cars per render tier (fewer on lower tiers) and sizes each model batch for its peak',()=>{
    expect(RENDER_BUDGET_LEVELS.map(level=>level.trafficCars)).toEqual([16,14,10,6,6]);
    expect(MAX_TRAFFIC_CARS).toBe(16);
    expect(trafficCarCap(99)).toBe(6);expect(trafficCarCap(-1)).toBe(16);
    for(const seed of seeds.slice(0,2)){
      const styles=dailyStyles(seed),bounds=trafficModelSlots(styles,MAX_TRAFFIC_CARS,MAX_LOT_CARS).slots;
      let previous=Infinity;
      RENDER_BUDGET_LEVELS.forEach((_,level)=>{
        const cap=trafficCarCap(level),net=createTrafficNetwork(seed,styles,MAX_TRAFFIC_CARS+MAX_LOT_CARS,{total:MAX_TRAFFIC_CARS,headroom:MAX_LOT_CARS});
        const input={density:1,cap,headroom:0};
        let most=0;
        advanceTrafficNetwork(net,60,input,.1);
        simulate(net,input,420,network=>{
          most=Math.max(most,network.count);
          expect(network.count).toBeLessThanOrEqual(cap);
          const perModel=new Map<MobilityModel,number>();
          for(let i=0;i<network.count;i++){const model=network.poses[i]!.model;perModel.set(model,(perModel.get(model)??0)+1);}
          perModel.forEach((count,model)=>expect(count).toBeLessThanOrEqual(bounds.get(model)!));
        });
        expect(most).toBeLessThanOrEqual(previous);previous=most;
      });
    }
    for(const [model,count] of TRAFFIC_INSTANCES){expect(count).toBeGreaterThan(0);expect(count).toBeLessThanOrEqual(MAX_TRAFFIC_CARS+MAX_LOT_CARS);expect(DAILY_CATALOG.map(vehicle=>vehicle.model)).toContain(model);}
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
