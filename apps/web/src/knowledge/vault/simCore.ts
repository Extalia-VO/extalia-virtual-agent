import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type SimNode, type Simulation } from 'd3-force-3d';
import { encodeFrame, graphDepthSeed, SIM_ALPHA_MIN, SIM_POST_HZ, SIM_REHEAT_ALPHA, type SimCommand, type SimFrame, type Encoded } from './simProtocol';

/**
 * The vault graph's force layout (d3-force-3d, Barnes–Hut octree), driven in time slices so it
 * can run in a worker or, as a fallback, on the main thread. It ticks as fast as a slice allows,
 * posts at most `SIM_POST_HZ` frames a second, and stops once cooled below `SIM_ALPHA_MIN`.
 */
export interface SimHost {
  post: (frame: Encoded<SimFrame>) => void;
  /** Schedule the next slice (setTimeout in both worker and main thread). */
  schedule: (run: () => void) => void;
  now: () => number;
}

interface Node extends SimNode { degree: number; group?: number }

/** Milliseconds of ticking per slice: leaves the worker (or the main thread) responsive. */
const SLICE_MS = 8;
const MAX_SLICE_TICKS = 32;
const RETURN_MS = 600;
// A stalled host clock must not leave a return scheduling work forever.
const MAX_RETURN_SLICES = 600;

interface ReturnAnimation { from: Float64Array; elapsed: number; lastTime: number; slices: number }

export function createSimCore(host: SimHost) {
  let simulation: Simulation<Node> | null = null;
  let nodes: Node[] = [];
  let edges: Uint32Array = new Uint32Array(0);
  let groups: Uint32Array | undefined;
  let dimensions: 2 | 3 = 3;
  let active: Uint8Array = new Uint8Array(0);
  let running = false;
  let paused = false;
  let scheduled = false;
  let lastPost = -Infinity;
  let dragging = -1;
  let returnToLayout = true;
  let reducedMotion = false;
  // Never transfer this buffer: renderer-owned frames can be detached on post.
  let rest: Float64Array | null = null;
  let returning: ReturnAnimation | null = null;

  const unpin = () => {
    const node = nodes[dragging];
    if (node) { node.fx = null; node.fy = null; node.fz = null; }
    dragging = -1;
    simulation?.alphaTarget(0);
  };

  const snapshot = () => {
    const positions = new Float64Array(nodes.length * 3);
    nodes.forEach((node, i) => { positions[i * 3] = node.x ?? 0; positions[i * 3 + 1] = node.y ?? 0; positions[i * 3 + 2] = node.z ?? 0; });
    return positions;
  };

  const clearInteraction = () => {
    unpin();
    rest = null;
    returning = null;
    simulation?.stop();
  };

  const linkPairs = () => {
    // Node objects, not indices: the simulation renumbers the notes it is given (only the shown ones).
    const links: { source: Node; target: Node }[] = [];
    for (let e = 0; e < edges.length; e += 2) if (active[edges[e]!] && active[edges[e + 1]!]) links.push({ source: nodes[edges[e]!]!, target: nodes[edges[e + 1]!]! });
    return links;
  };

  const configure = () => {
    const shown = nodes.filter((_, i) => active[i]);
    const links = linkPairs();
    const count = Math.max(1, shown.length);
    // Larger vaults spread a little wider; hubs push harder so clusters open up around them.
    const groupIds = groups ? [...new Set(groups)].sort((a, b) => a - b) : [];
    const centers = new Map<number, [number, number, number]>();
    const radius = groupIds.length > 1 ? 60 + 3 * Math.sqrt(count) : 0;
    groupIds.forEach((group, index) => {
      const fraction = (index + .5) / Math.max(1, groupIds.length);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      if (dimensions === 2) {
        const distance = radius * Math.sqrt(fraction);
        centers.set(group, [Math.cos(angle) * distance, Math.sin(angle) * distance, 0]);
      } else {
        const y = 1 - 2 * fraction, across = Math.sqrt(Math.max(0, 1 - y * y));
        centers.set(group, [radius * across * Math.cos(angle), radius * y, radius * across * Math.sin(angle)]);
      }
    });
    const linkForce = forceLink<Node>(links).distance(link => {
      const a = link.source as Node, b = link.target as Node;
      return 14 + 2.2 * Math.sqrt(Math.min(a.degree, b.degree)) + (groups && a.group !== b.group ? 40 : 0);
    }).iterations(1);
    if (groups) linkForce.strength(link => (link.source as Node).group === (link.target as Node).group ? 0.12 : 0.02);
    const simulationBuilder = forceSimulation<Node>([], dimensions).stop()
      .alphaMin(SIM_ALPHA_MIN).alphaDecay(1 - Math.pow(SIM_ALPHA_MIN, 1 / 240)).velocityDecay(0.38)
      .nodes(shown)
      .force('link', linkForce);
    simulationBuilder
      .force('charge', forceManyBody<Node>().strength(node => -14 - 5 * Math.sqrt(node.degree)).theta(0.9).distanceMax(220 + 4 * Math.sqrt(count)))
      .force('x', forceX<Node>(0).strength(groups ? 0.006 : 0.035))
      .force('y', forceY<Node>(0).strength(groups ? 0.006 : 0.035));
    if (groups) {
      simulationBuilder
        .force('groupX', forceX<Node>(node => centers.get(node.group ?? 0)?.[0] ?? 0).strength(0.045))
        .force('groupY', forceY<Node>(node => centers.get(node.group ?? 0)?.[1] ?? 0).strength(0.045));
    }
    simulationBuilder.force('z', dimensions === 3 ? forceZ<Node>(0).strength(groups ? 0.006 : 0.035) : null);
    if (groups && dimensions === 3) simulationBuilder.force('groupZ', forceZ<Node>(node => centers.get(node.group ?? 0)?.[2] ?? 0).strength(0.045));
    simulation = simulationBuilder;
    simulation.stop();
  };

  const frame = (): Float32Array => {
    const positions = new Float32Array(nodes.length * 3);
    nodes.forEach((node, i) => { positions[i * 3] = node.x ?? 0; positions[i * 3 + 1] = node.y ?? 0; positions[i * 3 + 2] = dimensions === 2 ? 0 : node.z ?? 0; });
    return positions;
  };

  const post = (force = false) => {
    const now = host.now();
    if (!force && now - lastPost < 1000 / SIM_POST_HZ) return;
    lastPost = now;
    host.post(encodeFrame(frame(), simulation?.alpha() ?? 0, running));
  };

  const applyReturn = (progress: number) => {
    if (!rest || !returning) return;
    const target = rest;
    const from = returning.from;
    const ease = 1 - Math.pow(1 - progress, 3);
    nodes.forEach((node, i) => {
      const at = i * 3;
      // Assign the stored coordinates at completion, without interpolation roundoff.
      node.x = progress === 1 ? target[at]! : from[at]! + (target[at]! - from[at]!) * ease;
      node.y = progress === 1 ? target[at + 1]! : from[at + 1]! + (target[at + 1]! - from[at + 1]!) * ease;
      node.z = dimensions === 2 ? 0 : progress === 1 ? target[at + 2]! : from[at + 2]! + (target[at + 2]! - from[at + 2]!) * ease;
      node.vx = 0; node.vy = 0; node.vz = 0;
    });
    if (progress === 1) {
      returning = null;
      running = false;
      simulation?.alphaTarget(0).alpha(0).stop();
      post(true);
    } else post();
  };

  const restore = () => {
    if (!rest || !simulation) return;
    unpin();
    returning = { from: snapshot(), elapsed: 0, lastTime: host.now(), slices: 0 };
    running = true;
    if (reducedMotion) applyReturn(1);
    else wake();
  };

  const slice = () => {
    scheduled = false;
    if (!simulation || !running || paused) return;
    if (returning) {
      const now = host.now();
      returning.elapsed += Math.max(0, now - returning.lastTime);
      returning.lastTime = now;
      returning.slices++;
      applyReturn(returning.slices >= MAX_RETURN_SLICES ? 1 : Math.min(1, returning.elapsed / RETURN_MS));
      wake();
      return;
    }
    const start = host.now();
    let ticks = 0;
    do { simulation.tick(); ticks++; } while (ticks < MAX_SLICE_TICKS && host.now() - start < SLICE_MS && (simulation.alpha() >= SIM_ALPHA_MIN || dragging >= 0));
    if (simulation.alpha() < SIM_ALPHA_MIN && dragging < 0) { running = false; post(true); return; }
    post();
    wake();
  };
  const wake = () => { if (!scheduled && running && !paused) { scheduled = true; host.schedule(slice); } };
  const start = (alpha: number) => { if (!simulation) return; simulation.alpha(Math.max(simulation.alpha(), alpha)); running = true; wake(); };

  return {
    handle(command: SimCommand) {
      switch (command.type) {
        case 'init': {
          clearInteraction();
          edges = command.edges;
          groups = command.groups;
          dimensions = command.dimensions ?? 3;
          active = new Uint8Array(command.count).fill(1);
          nodes = Array.from({ length: command.count }, (_, i) => {
            const node: Node = { index: i, degree: command.degree[i] ?? 0, ...(groups ? { group: groups[i] } : {}) };
            const seed = command.seed;
            if (seed && Number.isFinite(seed[i * 3]) && Number.isFinite(seed[i * 3 + 1]) && Number.isFinite(seed[i * 3 + 2])) {
              node.x = seed[i * 3]!; node.y = seed[i * 3 + 1]!; node.z = seed[i * 3 + 2]!;
            }
            if (dimensions === 2) { node.z = 0; node.vz = 0; }
            return node;
          });
          configure();
          // A refresh that kept most positions only needs a settle; a new layout starts hot.
          start(command.seed ? SIM_REHEAT_ALPHA : 1);
          post(true);
          return;
        }
        case 'mask': {
          if (command.active.length !== nodes.length) return;
          clearInteraction();
          active = command.active;
          configure();
          start(SIM_REHEAT_ALPHA);
          return;
        }
        case 'dimensions': {
          if (command.value === dimensions) return;
          clearInteraction();
          dimensions = command.value;
          nodes.forEach(node => {
            node.vx = 0; node.vy = 0; node.vz = 0;
            if (dimensions === 2) node.z = 0;
            else {
              node.z = graphDepthSeed(node.index ?? 0, node.group ?? 0);
            }
          });
          configure();
          start(SIM_REHEAT_ALPHA);
          post(true);
          return;
        }
        case 'drag': {
          const node = nodes[command.index];
          if (!node || !simulation || !active[command.index] || !Number.isFinite(command.x) || !Number.isFinite(command.y) || !Number.isFinite(command.z)) return;
          if (dragging < 0 && !returning) {
            const captured = snapshot();
            if (!captured.every(Number.isFinite)) return;
            rest = captured;
          }
          // A new drag may interrupt a return, but must retain its original target.
          returning = null;
          unpin();
          dragging = command.index;
          node.fx = command.x; node.fy = command.y; node.fz = dimensions === 2 ? null : command.z;
          if (dimensions === 2) { node.z = 0; node.vz = 0; }
          simulation.alphaTarget(0.25);
          start(0.25);
          return;
        }
        case 'release': {
          if (command.index !== dragging || dragging < 0) return;
          unpin();
          if (returnToLayout) restore();
          return;
        }
        case 'interaction': {
          returnToLayout = command.returnToLayout;
          reducedMotion = command.reducedMotion ?? false;
          if (returning && !returnToLayout) { returning = null; start(SIM_REHEAT_ALPHA); }
          else if (returning && reducedMotion) applyReturn(1);
          return;
        }
        case 'restore': restore(); return;
        case 'reheat': if (!returning) start(command.alpha); return;
        case 'pause': paused = true; return;
        case 'resume': paused = false; if (returning) returning.lastTime = host.now(); wake(); return;
      }
    },
    /** For tests: whether the layout is still moving. */
    get running() { return running; },
    get alpha() { return simulation?.alpha() ?? 0; },
  };
}
