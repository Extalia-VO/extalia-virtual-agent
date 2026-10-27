import { Suspense, useMemo, type ReactNode, type RefObject } from "react";
import type { Group } from "three";
import type { FurnishedOfficeView } from "./FurnishedFloors";
import { StaticCampusBatch } from "./StaticCampusBatch";
import { CampusBuildingShell } from "./CampusBuildingShell";
import { ExtaliaCampusSignage } from "./prefabs/architecture/ExtaliaSignage";
import { RoofSignage3D } from "./prefabs/architecture/RoofSignage3D";
import { RoofUtilities } from "./RoofUtilities";
import { RoofMaintenanceStair } from "./prefabs/architecture/RoofMaintenanceStair";
import { ROOF_FAN_MOTORS, RoofFanMotion } from "./roofFanMotion";
import { campusModelUrl, ModelBoundary, useCampusModelReady, useLiveModel, type CampusModelName } from "./campusModels";

export { roleOf } from "./campusModels";

/** The canopy sign backing in the model (Blender "Entrance - canopy sign backing"): centre height and front face. */
export const MODEL_LINTEL = Object.freeze({ y: 3.37, frontZ: -22.48 });
/** The reviewed plinth's centreline and acrylic baseline; reuse the original animated neon lettering. */
export const MODEL_ROOF_SIGN = [-10.7, 21.35, -19.12] as const;

export function CampusRoofSignage() {
  const modelShown = useCampusModelReady("extalia-shell");
  return <RoofSignage3D {...(modelShown ? { position: [...MODEL_ROOF_SIGN] as [number, number, number], supportsFromModel: true } : {})} />;
}

function Model({ name, url }: { name: CampusModelName; url: string }) {
  const { root } = useLiveModel(name, url);
  return <StaticCampusBatch key={root.uuid}>
    <primitive object={root} name={`extalia-model-${name}`} />
  </StaticCampusBatch>;
}

/** A Blender part when its file is present, else (or if it fails) its three.js backup. */
function ModelOrBackup({ name, backup, render }: { name: CampusModelName; backup: ReactNode; render?: (url: string) => ReactNode }) {
  const url = campusModelUrl(name);
  if (!url) return <>{backup}</>;
  return <ModelBoundary name={name} fallback={backup}>
    <Suspense fallback={null}>{render ? render(url) : <Model name={name} url={url} />}</Suspense>
  </ModelBoundary>;
}

/**
 * The campus building and its entrance lettering: the Blender skin when present (lettering on
 * the model's canopy sign), otherwise the three.js shell (lettering on its canopy fascia).
 */
export function CampusBuilding() {
  const modelShown = useCampusModelReady("extalia-shell");
  return <>
    <ModelOrBackup name="extalia-shell" backup={<StaticCampusBatch><CampusBuildingShell /></StaticCampusBatch>} />
    <ExtaliaCampusSignage {...(modelShown ? { lintel: MODEL_LINTEL } : {})} />
  </>;
}

/** The Blender roof plant, with its eight fan rotors (AC_FAN_ROTOR_00..07) spun by the app's motors. */
function RoofUtilitiesModel({ url }: { url: string }) {
  const { root } = useLiveModel("roof-utilities", url);
  const rotors = useMemo(() => ROOF_FAN_MOTORS.map((_, index): RefObject<Group | null> =>
    ({ current: (root.getObjectByName(`AC_FAN_ROTOR_${String(index).padStart(2, "0")}`) as Group | undefined) ?? null })), [root]);
  return <>
    <primitive object={root} name="extalia-model-roof-utilities" />
    <RoofFanMotion rotors={rotors} />
  </>;
}

export function CampusRoofUtilities() {
  return <ModelOrBackup name="roof-utilities" backup={<StaticCampusBatch><RoofUtilities /></StaticCampusBatch>}
    render={url => <RoofUtilitiesModel url={url} />} />;
}

export function CampusRoofStair({ view = "campus" }: { view?: FurnishedOfficeView }) {
  const modelShown = useCampusModelReady("roof-stair");
  // A hidden Three.js group would keep door portals and fixtures registered on other floors.
  if (view !== "campus" && view !== "stack" && view !== 3) return null;
  return <>
    <ModelOrBackup name="roof-stair" backup={null} />
    <RoofMaintenanceStair modelShown={modelShown} />
  </>;
}

/** The F3 terrace's glass balustrade, base shoes and top rails; the three.js rails stand in when it is absent. */
export function CampusTerraceGuard() {
  return <ModelOrBackup name="terrace" backup={null} />;
}

/** The lifts' static frames, rails, glazing and bridges; the cabs and doors stay in GlassElevator. */
export function CampusElevatorFrames() {
  return <ModelOrBackup name="elevators" backup={null} />;
}
