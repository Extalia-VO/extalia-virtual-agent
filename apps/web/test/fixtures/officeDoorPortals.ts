import type { DoorInfo } from '../../src/office/scene/interior/doorTraffic';

/**
 * Runtime portal geometry exported from the rendered office for door liveness regression coverage.
 * Kept as source data so tests do not depend on a browser or temporary filesystem export.
 */
export const OFFICE_DOOR_PORTALS = [
  {"id":"floor-1.exterior.emergency-exit","floor":1,"center":[-21,0,10],"yaw":-1.5707963267948963,"clearWidth":1.8,"height":2.55,"openAngle":-1.5707963267948966,"handleHeight":1.08,"handleOffset":0.15,"sliding":false},
  {"id":"floor-1.lobby.exterior","floor":1,"center":[0,0,-19],"yaw":3.141592653589793,"clearWidth":2.4,"height":2.65,"openAngle":0,"sliding":true},
  {"id":"floor-1.engineering.north","floor":1,"center":[-5,0,-11],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-1.engineering.east","floor":1,"center":[11,0,-1.2],"yaw":-1.5707963267948963,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-1.engineering.south","floor":1,"center":[-5,0,8.600000000000001],"yaw":0,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-1.library.entry","floor":1,"center":[-16.6,0,11.399999999999999],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-1.operations.entry","floor":1,"center":[-8.1,0,11.399999999999999],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-1.source-control.entry","floor":1,"center":[0.10000000000000009,0,11.399999999999999],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-1.qa.entry","floor":1,"center":[8.3,0,11.399999999999999],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-1.entertainment.entry","floor":1,"center":[18.7,0,11.399999999999999],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.25,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.executive.entry","floor":2,"center":[-12,6.4,-9.8],"yaw":0,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-2.mission-control.entry","floor":2,"center":[4,6.4,-9.8],"yaw":0,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-2.architecture.entry","floor":2,"center":[8.75,6.4,10.600000000000001],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.meeting-a.entry","floor":2,"center":[-13,6.4,-6.6],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.archive.entry","floor":2,"center":[20.25,6.4,10.600000000000001],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.knowledge.entry","floor":2,"center":[-15.25,6.4,10.600000000000001],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.review.entry","floor":2,"center":[-3.75,6.4,10.600000000000001],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-2.meeting-b.entry","floor":2,"center":[3,6.4,-6.6],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-3.sky-lounge.entry","floor":3,"center":[-15.75,12.8,-12.8],"yaw":0,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-3.multi-engine.entry","floor":3,"center":[1.25,12.8,-12.8],"yaw":0,"clearWidth":1.6,"height":2.55,"openAngle":1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-3.sanctuary.entry","floor":3,"center":[-16,12.8,-9.5],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-3.flex.entry","floor":3,"center":[-6,12.8,-9.5],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-3.research.entry","floor":3,"center":[5,12.8,-9.5],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-3.executive-studio.entry","floor":3,"center":[-12,12.8,3.6999999999999993],"yaw":3.141592653589793,"clearWidth":1.6,"height":2.55,"openAngle":-1.5707963267948966,"hinge":"right","sliding":false},
  {"id":"floor-3.fitness.entry","floor":3,"center":[15,12.8,5.699999999999999],"yaw":3.141592653589793,"clearWidth":3.2,"height":2.55,"openAngle":0,"sliding":true},
  {"id":"floor-3.rooftop-terrace.entry","floor":3,"center":[1,12.8,13],"yaw":0,"clearWidth":2.4,"height":2.65,"openAngle":0,"sliding":true},
  {"id":"floor-3.roof-maintenance.terrace-gate","floor":3,"center":[-20.72,12.8,14.1],"yaw":1.5707963267948963,"clearWidth":1.2,"height":1.12,"openAngle":-1.5707963267948966,"hinge":"left","sliding":false},
  {"id":"floor-3.roof-maintenance.roof-gate","floor":3,"center":[-21.35,19.33,6.2],"yaw":1.5707963267948963,"clearWidth":1.2,"height":1.12,"openAngle":-1.5707963267948966,"hinge":"left","sliding":false},
] as const satisfies readonly (DoorInfo & { readonly id: string })[];
