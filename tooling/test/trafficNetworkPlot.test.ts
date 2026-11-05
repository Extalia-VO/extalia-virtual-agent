import { it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { ROAD_NETWORK, ROAD_RUNS, VISIBLE_DISTRICT, turnPose } from '../../apps/web/src/office/scene/campusRoadNetwork';
import { dailyStyles } from '../../apps/web/src/office/scene/campusMobilityLayout';
import { createTrafficNetwork, stepTrafficNetwork } from '../../apps/web/src/office/scene/trafficNetwork';
/** Opt-in: `EXTALIA_TRAFFIC_PLOT=<output directory> npx vitest run tooling/test/trafficNetworkPlot.test.ts` writes lane-graph.svg (lanes, turns, 2 minutes of tracks). */
const OUT = process.env.EXTALIA_TRAFFIC_PLOT ?? '';
it.skipIf(!OUT)('plots the lane graph and sample tracks to EXTALIA_TRAFFIC_PLOT', () => {
  mkdirSync(OUT, { recursive: true });
  const S = 4, ox = 170, oz = 175; // svg px per metre, offsets; svg y = (oz - z)*S (north up)
  const X = (x: number) => ((x + ox) * S).toFixed(1), Y = (z: number) => ((oz - z) * S).toFixed(1);
  const parts: string[] = [];
  const W = 340 * S, H = 300 * S;
  parts.push(`<rect width="${W}" height="${H}" fill="#f4f2ec"/>`);
  // Visible district
  const v = VISIBLE_DISTRICT;
  parts.push(`<rect x="${X(v.minX)}" y="${Y(v.maxZ)}" width="${(v.maxX - v.minX) * S}" height="${(v.maxZ - v.minZ) * S}" fill="#e3ead9" stroke="#6b8f58" stroke-dasharray="8 6"/>`);
  parts.push(`<rect x="${X(-23)}" y="${Y(19)}" width="${48 * S}" height="${38 * S}" fill="#c9ccd1" stroke="#888"/><text x="${X(-10)}" y="${Y(0)}" font-size="20" fill="#333">HQ</text>`);
  for (const r of ROAD_RUNS) {
    const [x0, x1, z0, z1] = r.axis === 'x' ? [r.from, r.to, r.at - r.width / 2, r.at + r.width / 2] : [r.at - r.width / 2, r.at + r.width / 2, r.from, r.to];
    parts.push(`<rect x="${X(x0)}" y="${Y(z1)}" width="${(x1 - x0) * S}" height="${(z1 - z0) * S}" fill="#5b6268"/>`);
  }
  for (const lane of ROAD_NETWORK.lanes) {
    const col = lane.entry ? '#2e9d4f' : lane.exit ? '#c0392b' : lane.crossing ? '#e0a020' : '#9fd3ff';
    parts.push(`<line x1="${X(lane.from[0])}" y1="${Y(lane.from[1])}" x2="${X(lane.to[0])}" y2="${Y(lane.to[1])}" stroke="${col}" stroke-width="2" marker-end="url(#a)"/>`);
  }
  const p = { x: 0, z: 0, yaw: 0 };
  for (const t of ROAD_NETWORK.turns) {
    let d = '';
    for (let s = 0; s <= t.length; s += .5) { turnPose(t, s, p); d += `${d ? 'L' : 'M'}${X(p.x)},${Y(p.z)}`; }
    parts.push(`<path d="${d}" fill="none" stroke="${t.kind === 'left' ? '#7fdc8a' : t.kind === 'right' ? '#ffb070' : '#d0e8ff'}" stroke-width="1"/>`);
  }
  for (const n of ROAD_NETWORK.nodes) parts.push(`<circle cx="${X(n.x)}" cy="${Y(n.z)}" r="${n.boundary ? 7 : 4}" fill="${n.boundary ? '#2e9d4f' : '#333'}"/>`);
  // Trajectories of the first cars of a run
  const seed = 20261030, net = createTrafficNetwork(seed, dailyStyles(seed));
  const tracks = new Map<number, string>(); const colours = ['#1f77b4', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#ff7f0e'];
  for (let i = 0; i < 30 * 120; i++) {
    stepTrafficNetwork(net, 1 / 30, { density: .8, cap: 16, headroom: 4 });
    if (i % 6) continue;
    for (let c = 0; c < net.count; c++) { const q = net.poses[c]!; if (q.id > 8) continue; tracks.set(q.id, (tracks.get(q.id) ?? '') + `${tracks.has(q.id) ? 'L' : 'M'}${X(q.x)},${Y(q.z)}`); }
  }
  let k = 0; for (const [id, d] of tracks) { parts.push(`<path d="${d}" fill="none" stroke="${colours[k++ % colours.length]}" stroke-width="3" opacity=".85"/><text x="${d.split('L')[0]!.slice(1).split(',')[0]}" y="${d.split('L')[0]!.split(',')[1]}" font-size="16">${id}</text>`); }
  // Snapshot of every car at 120 s
  for (let c = 0; c < net.count; c++) { const q = net.poses[c]!; parts.push(`<g transform="translate(${X(q.x)},${Y(q.z)}) rotate(${(-q.yaw * 180 / Math.PI + 180).toFixed(1)})"><rect x="${-1 * S}" y="${-2.3 * S}" width="${2 * S}" height="${4.6 * S}" fill="${q.stopped ? '#c0392b' : '#111'}"/></g>`); }
  parts.push(`<text x="20" y="30" font-size="22">Lane graph: green = entries, red = exits, amber = zebra-crossing lanes, blue = interior; turns: green left, orange right. Dashed = visible district. Tracks: first 8 cars over 120 s; black boxes = cars at t=120 s (red = braking).</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#333"/></marker></defs>${parts.join('')}</svg>`;
  writeFileSync(`${OUT}/lane-graph.svg`, svg);
}, 60000);
