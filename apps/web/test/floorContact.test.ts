import { describe, expect, it, vi } from "vitest";
import type * as ReactTypes from "react";
import type * as ExteriorEnvelopeTypes from "../src/office/scene/interior/ExteriorEnvelopeContext";
import type { ReactElement, ReactNode } from "react";
import { Floor1 } from "../src/office/scene/Floor1";
import { Floor2 } from "../src/office/scene/Floor2";
import { Floor3 } from "../src/office/scene/Floor3";
import { FloorFinish } from "../src/office/scene/interior/prefabs/finishes/FloorFinish";
import { RoomShell } from "../src/office/scene/interior/RoomShell";
import { StairwellFloorPlate } from "../src/office/scene/interior/prefabs/architecture/StairwellFloorPlate";
import { AreaRug, PendantLight } from "../src/office/scene/interior/prefabs/props/OfficeDecor";
import { FootprintBox } from "../src/office/scene/interior/FootprintPatch";
import { GrandFloorMedallion, CorridorWayfindingRunner, BarPendantCluster, DiningLinearPendant } from "../src/office/scene/interior/prefabs/architecture/GrandLobbyDecorations";
import { ServerRack } from "../src/office/scene/interior/prefabs/props/ServerRack";
import { Bookshelf, CoffeeTable, ConsoleTable, DisplayCabinet, StorageCabinet } from "../src/office/scene/interior/prefabs/furniture/TablesAndStorage";
import { Whiteboard } from "../src/office/scene/interior/prefabs/props/Whiteboard";
import { LOUNGE_FURNITURE_BLUEPRINT } from "../src/office/scene/interior/spatialBlueprints";

const canvasContext = new Proxy({}, { get: () => () => {} });
vi.stubGlobal("document", { createElement: () => ({ getContext: () => canvasContext }) });

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
}));
vi.mock("../src/office/scene/interior/FurnishedFloorContext", () => ({
  useFurnishedFloorState: () => ({ agents: [], allocations: [], language: "en" }),
}));
vi.mock("../src/office/scene/interior/FloorVisibilityContext", () => ({ useFloorVisible: () => true }));
vi.mock("../src/office/scene/interior/floorPanelModel", () => ({ useFloorPanelModel: () => null }));
vi.mock("../src/office/scene/interior/ExteriorEnvelopeContext", async importOriginal => ({
  ...await importOriginal<typeof ExteriorEnvelopeTypes>(),
  useExteriorEnvelopeActive: () => false,
}));
vi.mock("../src/office/scene/interior/prefabs/architecture/StructuralCeilingContext", () => ({ useStructuralCeiling: () => ({ floor: 1 }) }));
vi.mock("../src/office/scene/Environment", () => ({
  useSolarEnvironment: () => ({ state: { factors: { interiorLightFactor: 1, exteriorLightFactor: 1 } } }),
}));

type Props = { children?: ReactNode; position?: readonly number[]; rotation?: readonly number[]; name?: string; size?: readonly number[]; args?: readonly number[]; roomId?: string; floorFinish?: string };
type Element = ReactElement<Props>;
const EXPAND = new Set([FloorFinish, RoomShell, StairwellFloorPlate, AreaRug, GrandFloorMedallion, CorridorWayfindingRunner]);

function isElement(value: ReactNode): value is Element {
  return !!value && typeof value === "object" && "type" in value && "props" in value;
}

/** Expand only the scene wrappers that own floor surfaces; furniture stays opaque. */
function resolved(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(child => resolved(child));
  if (!isElement(node)) return node;
  if (typeof node.type === "function" && EXPAND.has(node.type as never)) {
    return resolved((node.type as (props: Props) => ReactNode)(node.props));
  }
  return {
    ...node,
    props: { ...node.props, children: resolved(node.props.children) },
  };
}

function elements(node: ReactNode, predicate: (element: Element) => boolean, out: Element[] = []): Element[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, predicate, out); return out; }
  if (!isElement(node)) return out;
  if (predicate(node)) out.push(node);
  elements(node.props.children, predicate, out);
  return out;
}

function y(element: Element): number { return element.props.position?.[1] ?? 0; }
function childrenOf(element: Element) { return element.props.children; }

/** Returns world Y bounds from the actual box props below a rendered scene tree. */
function boxBounds(root: ReactNode, name: string) {
  const bounds: Array<{ top: number; bottom: number }> = [];
  const visit = (node: ReactNode, parentY: number): void => {
    if (Array.isArray(node)) { node.forEach(child => visit(child, parentY)); return; }
    if (!isElement(node)) return;
    const worldY = parentY + (node.type === "group" ? y(node) : 0);
    if (node.type === FootprintBox && node.props.name === name && node.props.size) {
      const sizeY = node.props.size[1] ?? 0;
      const centerY = node.props.position?.[1] ?? 0;
      bounds.push({ bottom: worldY + centerY - sizeY / 2, top: worldY + centerY + sizeY / 2 });
    }
    visit(childrenOf(node), worldY);
  };
  visit(root, 0);
  return bounds;
}

function rugBounds(root: ReactNode) {
  const bounds: Array<{ top: number; bottom: number }> = [];
  const visit = (node: ReactNode, parentY: number): void => {
    if (Array.isArray(node)) { node.forEach(child => visit(child, parentY)); return; }
    if (!isElement(node)) return;
    const worldY = parentY + (node.type === "group" ? y(node) : 0);
    if (node.type === "mesh") {
      const geometry = elements(childrenOf(node), child => child.type === "boxGeometry")[0];
      const height = geometry?.props.args?.[1];
      if (typeof height === "number") {
        const center = y(node);
        bounds.push({ bottom: worldY + center - height / 2, top: worldY + center + height / 2 });
      }
    }
    visit(childrenOf(node), worldY);
  };
  visit(root, 0);
  return bounds;
}

function floorTree(component: () => ReactNode) { return resolved(component()); }

describe("finished floor contacts", () => {
  it("keeps F1–F3 finishes at the navigation datum and slabs below it", () => {
    for (const [floor, component] of [[1, Floor1], [2, Floor2], [3, Floor3]] as const) {
      const tree = floorTree(component);
      const finishes = elements(tree, element => element.type === "group" && element.props.name === "office-floor-finish");
      expect(finishes.length, `F${floor} should render room, corridor and underlay finishes`).toBeGreaterThan(4);

      const panelTops = finishes.flatMap(finish => boxBounds(finish, "office-floor-panel").map(bounds => bounds.top));
      expect(panelTops.length).toBeGreaterThan(4);
      for (const top of panelTops) expect(Math.min(Math.abs(top), Math.abs(top + 0.002))).toBeLessThan(1e-5);
      expect(panelTops.some(top => Math.abs(top + 0.002) < 1e-5), `F${floor} underlay is set just below the walking surface`).toBe(true);
      expect(panelTops.some(top => Math.abs(top) < 1e-5), `F${floor} has finished surfaces at datum`).toBe(true);

      const inlayTops = finishes.flatMap(finish => boxBounds(finish, "office-floor-inlay").map(bounds => bounds.top));
      for (const top of inlayTops) expect(top).toBeCloseTo(0, 5);

      const slabs = boxBounds(tree, "office-floor-slab");
      expect(slabs.length).toBeGreaterThan(0);
      for (const slab of slabs) {
        expect(slab.top).toBeCloseTo(-0.08, 5);
        expect(slab.bottom).toBeCloseTo(-0.32, 5);
      }
    }
  });

  it("rests all rendered area rugs on the datum with only a thin pile above it", () => {
    for (const component of [Floor1, Floor2, Floor3]) {
      const tree = floorTree(component);
      const rugs = elements(tree, element => element.type === "group" && element.props.name === "office-area-rug");
      expect(rugs.length).toBeGreaterThan(0);
      for (const rug of rugs) {
        const boxes = rugBounds(rug);
        expect(boxes.length).toBeGreaterThanOrEqual(2);
        // A half-millimetre overlay separates the freeweights rug from its larger gym mat.
        expect(Math.min(...boxes.map(box => box.bottom))).toBeLessThanOrEqual(0.001);
        for (const box of boxes) {
          expect(box.bottom).toBeGreaterThanOrEqual(-1e-5);
          expect(box.top).toBeLessThanOrEqual(0.007);
        }
      }
    }
  });

  it("keeps lobby inlays flush, racks grounded, and the fitness aisle free of duplicate floor layers", () => {
    const lobby = floorTree(Floor1);
    const runner = elements(lobby, element => element.props.name === "office-floor-runner");
    expect(runner).toHaveLength(1);
    for (const box of rugBounds(runner)) expect(box.top).toBeCloseTo(0, 5);
    const medallion = elements(lobby, element => element.props.name === "office-floor-medallion");
    expect(medallion).toHaveLength(1);
    expect(y(medallion[0]!)).toBe(0);
    const faces = elements(medallion, element => element.type === "mesh");
    expect(faces).toHaveLength(7);
    for (const face of faces) {
      expect(y(face)).toBeGreaterThanOrEqual(0);
      expect(y(face)).toBeLessThanOrEqual(0.0005);
      expect(face.props.rotation?.[0]).toBeCloseTo(-Math.PI / 2);
    }
    const racks = elements(Floor1(), element => element.type === ServerRack);
    expect(racks).toHaveLength(3);
    for (const rack of racks) expect(y(rack)).toBe(0);
    const fitness = elements(Floor3(), element => element.type === RoomShell && element.props.roomId === "fitness")[0]!;
    expect(fitness.props.floorFinish).toBe("stone");
    expect(elements(fitness.props.children, element => element.type === FloorFinish)).toHaveLength(0);
  });

  it("anchors F3 Research Area bookshelves, storage cabinets and whiteboard flush against the 12 × 10 m room walls", () => {
    const research = elements(Floor3(), element => element.type === RoomShell && element.props.roomId === "research")[0]!;
    expect(research.props.size).toEqual([12, 10]);
    const shelves = elements(research.props.children, element => element.type === Bookshelf);
    expect(shelves).toHaveLength(4);
    for (const shelf of shelves) {
      expect(Math.abs(shelf.props.position![0]!)).toBeCloseTo(5.68, 5);
    }
    const cabinets = elements(research.props.children, element => element.type === StorageCabinet);
    expect(cabinets).toHaveLength(2);
    for (const cabinet of cabinets) {
      expect(cabinet.props.position![2]).toBeCloseTo(4.62, 5);
    }
    const board = elements(research.props.children, element => element.type === Whiteboard)[0]!;
    expect(board.props.position![2]).toBeCloseTo(4.9, 5);

    const archive = elements(Floor2(), element => element.type === RoomShell && element.props.roomId === "archive")[0]!;
    expect(archive.props.size).toEqual([9.5, 8.4]);
    const archiveDisplays = elements(archive.props.children, element => element.type === DisplayCabinet);
    expect(archiveDisplays).toHaveLength(2);
    for (const display of archiveDisplays) {
      expect(Math.abs(display.props.position![0]!)).toBeCloseTo(4.44, 5);
    }
    const archiveShelf = elements(archive.props.children, element => element.type === Bookshelf)[0]!;
    expect(archiveShelf.props.position![0]).toBeCloseTo(-4.46, 5);
    const archiveConsole = elements(archive.props.children, element => element.type === ConsoleTable)[0]!;
    expect(archiveConsole.props.position![0]).toBeCloseTo(4.48, 5);

    const qa = elements(Floor1(), element => element.type === RoomShell && element.props.roomId === "qa")[0]!;
    expect(qa.props.size).toEqual([8.2, 7.6]);
    const qaCabinets = elements(qa.props.children, element => element.type === StorageCabinet);
    expect(qaCabinets).toHaveLength(3);
    for (const cabinet of qaCabinets) {
      expect(Math.abs(cabinet.props.position![0]!)).toBeCloseTo(3.76, 5);
    }
    const qaConsole = elements(qa.props.children, element => element.type === ConsoleTable)[0]!;
    expect(qaConsole.props.position![0]).toBeCloseTo(3.82, 5);

    const barPendant = elements(Floor1(), element => element.type === BarPendantCluster)[0]!;
    expect((barPendant.props as { drop?: number }).drop).toBeCloseTo(0.45, 5);
    const diningPendant = elements(Floor1(), element => element.type === DiningLinearPendant)[0]!;
    expect((diningPendant.props as { drop?: number }).drop).toBeCloseTo(0.85, 5);
    expect(LOUNGE_FURNITURE_BLUEPRINT.coffeeTable.position).toEqual([0.05, 0, 0]);
    expect(LOUNGE_FURNITURE_BLUEPRINT.westCornerLamp).toEqual([-6.35, 0, 8.8]);
    expect(LOUNGE_FURNITURE_BLUEPRINT.diningCornerLamp).toEqual([6.35, 0, 8.8]);
    const loungeReading = elements(Floor1(), element => element.type === "group" &&
      element.props.position?.[0] === LOUNGE_FURNITURE_BLUEPRINT.readingOrigin[0] &&
      element.props.position?.[2] === LOUNGE_FURNITURE_BLUEPRINT.readingOrigin[2])[0]!;
    const readingPendant = elements(loungeReading.props.children, element => element.type === PendantLight)[0]!;
    const readingTable = elements(loungeReading.props.children, element => element.type === CoffeeTable)[0]!;
    expect(readingPendant.props.position![0]).toBeCloseTo(readingTable.props.position![0]!, 5);
    expect(readingPendant.props.position![2]).toBeCloseTo(readingTable.props.position![2]!, 5);

    const expandLightTrees = (node: ReactNode): ReactNode => {
      if (Array.isArray(node)) return node.map(expandLightTrees);
      if (!isElement(node)) return node;
      if (typeof node.type === "function" && ["RoomShell", "RoomCeilingDownlights", "TeamWorkspaceCeilingLights", "LobbyCeilingLights"].includes(node.type.name)) {
        return expandLightTrees((node.type as (props: Props) => ReactNode)(node.props));
      }
      return { ...node, props: { ...node.props, children: expandLightTrees(node.props.children) } };
    };
    const f1Lights = expandLightTrees(Floor1());
    const f2Lights = expandLightTrees(Floor2());
    const f3Lights = expandLightTrees(Floor3());

    // TeamWorkspaceCeilingLights perimeter wall washers stay inside the 32 m engineering envelope (|x| <= 16).
    const wallWashers = elements(f1Lights, element => element.props.name === "structural-wall-washer");
    expect(wallWashers).toHaveLength(3);
    const lobbyDownlights = elements(f1Lights, element => element.props.name === "structural-lobby-housing");
    expect(lobbyDownlights).toHaveLength(16);

    // Executive suites use ExecutiveSuiteLighting rather than duplicate RoomCeilingDownlights boxes.
    const executiveRoom = elements(f2Lights, element => element.props.name === "office-room:executive")[0]!;
    expect(elements(executiveRoom, element => element.props.name === "structural-room-housing")).toHaveLength(0);
    const studioRoom = elements(f3Lights, element => element.props.name === "office-room:executive-studio")[0]!;
    expect(elements(studioRoom, element => element.props.name === "structural-room-housing")).toHaveLength(0);

    // Wide and extra-wide rooms use clean 3×2 (6) and 4×2 (8) rectangular ceiling grids.
    const missionRoom = elements(f2Lights, element => element.props.name === "office-room:mission-control")[0]!;
    expect(elements(missionRoom, element => element.props.name === "structural-room-housing")).toHaveLength(6);
    const multiEngineRoom = elements(f3Lights, element => element.props.name === "office-room:multi-engine")[0]!;
    expect(elements(multiEngineRoom, element => element.props.name === "structural-room-housing")).toHaveLength(8);
    const fitnessRoom = elements(f3Lights, element => element.props.name === "office-room:fitness")[0]!;
    expect(elements(fitnessRoom, element => element.props.name === "structural-room-housing")).toHaveLength(8);
  });
});
