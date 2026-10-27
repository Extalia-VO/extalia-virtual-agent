import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type SimNode, type Simulation } from 'd3-force-3d';
import { encodeFrame, SIM_ALPHA_MIN, SIM_POST_HZ, SIM_REHEAT_ALPHA, type SimCommand, type SimFrame, type Encoded } from './simProtocol';

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

interface Node extends SimNode { degree: number }

/** Milliseconds of ticking per slice: leaves the worker (or the main thread) responsive. */
const SLICE_MS = 8;

export function createSimCore(host: SimHost) {
  let simulation: Simulation<Node> | null = null;
  let nodes: Node[] = [];
  let edges: Uint32Array = new Uint32Array(0);
  let active: Uint8Array = new Uint8Array(0);
  let running = false;
  let paused = false;
  let scheduled = false;
  let lastPost = -Infinity;
  let dragging = -1;

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
    simulation = forceSimulation<Node>([], 3).stop()
      .alphaMin(SIM_ALPHA_MIN).alphaDecay(1 - Math.pow(SIM_ALPHA_MIN, 1 / 240)).velocityDecay(0.38)
      .nodes(shown)
      .force('link', forceLink<Node>(links).distance(link => {
        const a = link.source as Node, b = link.target as Node;
        return 14 + 2.2 * Math.sqrt(Math.min(a.degree, b.degree));
      }).iterations(1))
      .force('charge', forceManyBody<Node>().strength(node => -14 - 5 * Math.sqrt(node.degree)).theta(0.9).distanceMax(220 + 4 * Math.sqrt(count)))
      .force('x', forceX<Node>(0).strength(0.035))
      .force('y', forceY<Node>(0).strength(0.035))
      .force('z', forceZ<Node>(0).strength(0.035));
    simulation.stop();
  };

  const frame = (): Float32Array => {
    const positions = new Float32Array(nodes.length * 3);
    nodes.forEach((node, i) => { positions[i * 3] = node.x ?? 0; positions[i * 3 + 1] = node.y ?? 0; positions[i * 3 + 2] = node.z ?? 0; });
    return positions;
  };

  const post = (force = false) => {
    const now = host.now();
    if (!force && now - lastPost < 1000 / SIM_POST_HZ) return;
    lastPost = now;
    host.post(encodeFrame(frame(), simulation?.alpha() ?? 0, running));
  };

  const slice = () => {
    scheduled = false;
    if (!simulation || !running || paused) return;
    const start = host.now();
    do simulation.tick(); while (host.now() - start < SLICE_MS && (simulation.alpha() >= SIM_ALPHA_MIN || dragging >= 0));
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
          edges = command.edges;
          active = new Uint8Array(command.count).fill(1);
          nodes = Array.from({ length: command.count }, (_, i) => {
            const node: Node = { index: i, degree: command.degree[i] ?? 0 };
            const seed = command.seed;
            if (seed && Number.isFinite(seed[i * 3]) && Number.isFinite(seed[i * 3 + 1]) && Number.isFinite(seed[i * 3 + 2])) {
              node.x = seed[i * 3]!; node.y = seed[i * 3 + 1]!; node.z = seed[i * 3 + 2]!;
            }
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
          active = command.active;
          configure();
          start(SIM_REHEAT_ALPHA);
          return;
        }
        case 'drag': {
          const node = nodes[command.index];
          if (!node || !simulation) return;
          dragging = command.index;
          node.fx = command.x; node.fy = command.y; node.fz = command.z;
          simulation.alphaTarget(0.25);
          start(0.25);
          return;
        }
        case 'release': {
          const node = nodes[command.index];
          if (node) { node.fx = null; node.fy = null; node.fz = null; }
          dragging = -1;
          simulation?.alphaTarget(0);
          return;
        }
        case 'reheat': start(command.alpha); return;
        case 'pause': paused = true; return;
        case 'resume': paused = false; wake(); return;
      }
    },
    /** For tests: whether the layout is still moving. */
    get running() { return running; },
    get alpha() { return simulation?.alpha() ?? 0; },
  };
}
