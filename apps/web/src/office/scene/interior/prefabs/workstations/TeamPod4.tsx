import { useMemo } from "react";
import {
  DoubleSide,
  ExtrudeGeometry,
  Shape
} from "three";
import type { FurnishedFloorState } from "../../FurnishedFloorContext";
import type { SmartScreenData } from "../../screenData";
import { screenForLocation } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Laptop } from "../props/Laptop";
import { Keyboard } from "../props/Keyboard";
import { MouseAndPad } from "../props/DeskAccessories";
import { TEAM_POD_SEAT, TEAM_POD_STATIONS } from "../../spatialBlueprints";

type DeviceVariant =
  | "dual-monitor"
  | "all-in-one"
  | "monitor-laptop"
  | "laptop";

type StationDefinition = typeof TEAM_POD_STATIONS[number];

function PointerForKeyboard({
  position,
  rotationY,
  scale = 0.75
}: {
  position: [number, number, number];
  rotationY: number;
  scale?: number;
}) {
  const side = 0.34;
  return (
    <MouseAndPad
      position={[position[0] + Math.cos(rotationY) * side, 0.797,
        position[2] - Math.sin(rotationY) * side]}
      rotationY={rotationY}
      scale={scale}
    />
  );
}

function QuadrantDeskSurface() {
  const geometry = useMemo(() => {
    const s = TEAM_POD_SEAT.deskHalfExtent;
    // The chair faces the diagonal corner. Bring both straight edges back
    // before the curve so the sitter has an actual knee/arm clearance bay.
    const seatOpening = TEAM_POD_SEAT.seatOpening;
    const curveTangent = 0.82;

    const shape = new Shape();
    shape.moveTo(0, 0);
    shape.lineTo(s, 0);
    shape.lineTo(s, seatOpening);
    shape.bezierCurveTo(
      s, curveTangent,
      curveTangent, s,
      seatOpening, s
    );

    shape.lineTo(0, s);
    shape.closePath();

    const g = new ExtrudeGeometry(shape, {
      depth: 0.10,
      curveSegments: 18,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.018,
      bevelSegments: 2
    });

    g.rotateX(Math.PI / 2);
    g.translate(0, 0.79, 0);

    return g;
  }, []);

  return (
    <mesh castShadow receiveShadow geometry={geometry}>
      <meshStandardMaterial color="#bf9367" roughness={0.72} side={DoubleSide} />
      <meshStandardMaterial color="#86684e" roughness={0.8} side={DoubleSide} />
    </mesh>
  );
}

function DeviceSet({
  variant,
  data
}: {
  variant: DeviceVariant;
  data: SmartScreenData;
}) {
  // Generic station is the SE quadrant.
  // A 45° screen yaw faces the diagonal SE chair.
  const diagonalFacing = Math.PI / 4;

  // ±20° around the diagonal creates about a 140° internal V
  // between the two monitor planes.
  const dualHalfAngle = Math.PI / 9;

  switch (variant) {
    case "dual-monitor":
      return (
        <>
          <Monitor
            position={[0.48, 1.24, 0.88]}
            rotationY={diagonalFacing + dualHalfAngle}
            width={0.56}
            height={0.34}
            variant="code"
            data={data}
          />

          <Monitor
            position={[0.88, 1.24, 0.48]}
            rotationY={diagonalFacing - dualHalfAngle}
            width={0.56}
            height={0.34}
            variant="chart"
            data={data}
          />

          <Keyboard
            position={[1.04, 0.82, 1.04]}
            rotationY={diagonalFacing}
          />
          <PointerForKeyboard position={[1.04, 0.82, 1.04]} rotationY={diagonalFacing} />
        </>
      );

    case "all-in-one":
      return (
        <>
          <Monitor
            position={[0.64, 1.25, 0.64]}
            rotationY={diagonalFacing}
            width={0.74}
            height={0.44}
            data={data}
          />

          <Keyboard
            position={[1.03, 0.82, 1.03]}
            rotationY={diagonalFacing}
          />
          <PointerForKeyboard position={[1.03, 0.82, 1.03]} rotationY={diagonalFacing} />
        </>
      );

    case "monitor-laptop":
      return (
        <>
          <Monitor
            position={[0.58, 1.23, 0.62]}
            rotationY={diagonalFacing + 0.08}
            width={0.62}
            height={0.37}
            data={data}
          />

          <Laptop
            position={[1.05, 0.84, 0.74]}
            rotationY={diagonalFacing - 0.15}
            variant="ops"
            data={data}
          />

          <Keyboard
            position={[0.84, 0.82, 1.06]}
            rotationY={diagonalFacing}
          />
          <PointerForKeyboard position={[0.84, 0.82, 1.06]} rotationY={diagonalFacing} />
        </>
      );

    case "laptop":
      return (
        <>
          <Laptop position={[0.86, 0.84, 0.86]} rotationY={diagonalFacing} data={data} />
          <Keyboard position={[0.86, 0.82, 1.14]} rotationY={diagonalFacing} />
          <PointerForKeyboard position={[0.86, 0.82, 1.14]} rotationY={diagonalFacing} />
        </>
      );
  }
}

function QuadrantStation({
  station,
  data
}: {
  station: StationDefinition;
  data: SmartScreenData;
}) {
  return (
    <group rotation={[0, station.rotationY, 0]} userData={{ officeSeatStation: true }}>
      <QuadrantDeskSurface />

      <DeviceSet
        variant={station.variant}
        data={data}
      />

      <OfficeChair
        position={[TEAM_POD_SEAT.chairPosition[0], 0, TEAM_POD_SEAT.chairPosition[1]]}
        rotationY={TEAM_POD_SEAT.chairRotationY}
      />

      <mesh castShadow position={[1.42, 0.39, 0.34]}>
        <boxGeometry args={[0.46, 0.72, 0.50]} />
        <meshStandardMaterial
          color="#d7d3cb"
          roughness={0.90}
        />
      </mesh>
    </group>
  );
}

export function TeamPod4({
  podId,
  floorState,
  position = [0, 0, 0],
  rotationY = 0
}: {
  podId: string;
  floorState: FurnishedFloorState;
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {TEAM_POD_STATIONS.map((station: StationDefinition) => {
        const data = screenForLocation(
          floorState,
          `floor-1.team-workspace.${podId}.${station.id}`
        );

        return (
          <QuadrantStation
            key={station.id}
            station={station}
            data={data}
          />
        );
      })}

      <mesh castShadow position={[0, 0.48, 0]}>
        <boxGeometry args={[0.44, 0.92, 0.44]} />
        <meshStandardMaterial
          color="#cfcac1"
          roughness={0.90}
        />
      </mesh>

      <mesh castShadow position={[0, 1.10, 0]}>
        <boxGeometry args={[3.12, 0.54, 0.045]} />
        <meshPhysicalMaterial
          color="#d8e6e8"
          transparent
          opacity={0.44}
          roughness={0.24}
        />
      </mesh>

      <mesh
        castShadow
        position={[0, 1.10, 0]}
        rotation={[0, Math.PI / 2, 0]}
      >
        <boxGeometry args={[3.12, 0.54, 0.045]} />
        <meshPhysicalMaterial
          color="#d8e6e8"
          transparent
          opacity={0.44}
          roughness={0.24}
        />
      </mesh>
    </group>
  );
}
