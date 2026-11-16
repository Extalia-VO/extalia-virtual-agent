import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import type { ResourceUsageAgent, ResourceUsageCopy, ResourceUsageGraph, ResourceUsageNode } from './resourceUsageTypes';
import './resourceUsageDiagram.css';

const PAGE_SIZE = 32;
const TRACE_SIZE = 12;

interface ViewState { agentId: string; teamId: string; selectedId?: string; limit: number }
const initialView = (): ViewState => ({ agentId: '', teamId: '', limit: PAGE_SIZE });

const MemoScopedResourceUsageDiagram = memo(ScopedResourceUsageDiagram);

/** A new conversation/run owns a new disclosure, filter and modal lifetime. */
export function ResourceUsageDiagram(props: { graph: ResourceUsageGraph; copy: ResourceUsageCopy; language: string; visible?: boolean }) {
  return <MemoScopedResourceUsageDiagram key={props.graph.scopeKey} {...props} />;
}

function ScopedResourceUsageDiagram({ graph, copy, language, visible = true }: { graph: ResourceUsageGraph; copy: ResourceUsageCopy; language: string; visible?: boolean }) {
  const [view, setView] = useState(initialView);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const patch = (value: Partial<ViewState>) => setView(previous => ({ ...previous, ...value }));
  const body = <DiagramBody graph={graph} copy={copy} language={language} view={view} patch={patch} expanded={false} />;
  if (!visible && !expanded) return null;
  return <section className="resource-usage" aria-labelledby={titleId} data-scope={graph.scopeKey} hidden={!visible}>
    <header className="resource-usage-heading">
      <Icon name="mission" /><h3 id={titleId}>{copy.title}</h3><span className="resource-usage-total">{copy.nodes(graph.nodes.length)}</span>
      <button ref={trigger} type="button" className="icon-button small" aria-label={copy.expand} title={copy.expand} onClick={() => setExpanded(true)}><Icon name="maximize" /></button>
    </header>
    <div inert={expanded || undefined} aria-hidden={expanded || undefined}>{body}</div>
    {expanded && <UsageDialog copy={copy} returnFocusRef={trigger} onClose={() => setExpanded(false)}>
      <DiagramBody graph={graph} copy={copy} language={language} view={view} patch={patch} expanded />
    </UsageDialog>}
  </section>;
}

function UsageDialog({ copy, returnFocusRef, onClose, children }: {
  copy: ResourceUsageCopy; returnFocusRef: RefObject<HTMLElement | null>; onClose(): void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current, returnFocus = returnFocusRef.current;
    if (!dialog) return;
    const rail = returnFocus?.closest<HTMLElement>('aside');
    if (!dialog.open) dialog.showModal();
    close.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      let target = returnFocus;
      if (!target?.isConnected || !target.getClientRects().length) {
        target = rail && [rail, ...rail.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]')]
          .find(element => element.matches('button:not([disabled]), [tabindex]') && element.getClientRects().length && !element.closest('[hidden], [inert]')) || null;
      }
      target?.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);
  return createPortal(<dialog ref={ref} className="resource-usage-dialog" aria-labelledby={titleId} aria-modal="true"
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="resource-usage-dialog-heading"><Icon name="mission" /><h2 id={titleId}>{copy.title}</h2><button ref={close} type="button" className="icon-button" aria-label={copy.close} title={copy.close} onClick={onClose}><Icon name="close" /></button></header>
    {children}
  </dialog>, document.body);
}

interface CanvasBox { x: number; y: number; width: number; height: number }
interface CanvasPort { x: number; y: number }
interface CanvasEdge { id: string; from: string; to: string; kind: 'parent' | 'team' | 'resource'; path: string; active: boolean; fromPort: CanvasPort; toPort: CanvasPort; routing: 'direct' | 'outer' }

/** Stable presentation geometry; compact rails stack, expanded dialogs retain owner columns. */
export function resourceUsageCanvasLayout(agents: readonly ResourceUsageAgent[], teams: ResourceUsageGraph['teams'], nodes: readonly ResourceUsageNode[], expanded: boolean, availableWidth = 280) {
  const padding = expanded ? 34 : 18, gap = expanded ? 36 : 18;
  const agentHeight = expanded ? 68 : 56, resourceHeight = expanded ? 76 : 64, rowGap = expanded ? 24 : 16;
  const root = agents.find(agent => agent.role === 'primary');
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const visibleTeams = teams.filter(team => agents.some(agent => agent.teamId === team.id && agent.id !== root?.id));
  const agentBoxes = new Map<string, CanvasBox>(), teamBoxes = new Map<string, CanvasBox>(), resourceBoxes = new Map<string, CanvasBox>();
  const groupIds = new Set<string>();
  const groups: ({ kind: 'agent'; agent: ResourceUsageAgent } | { kind: 'team'; id: string; members: ResourceUsageAgent[] })[] = [];
  for (const agent of agents) {
    if (agent.id === root?.id) continue;
    const team = visibleTeams.find(value => value.id === agent.teamId);
    if (!team) { groups.push({ kind: 'agent', agent }); continue; }
    if (!groupIds.has(team.id)) { groupIds.add(team.id); groups.push({ kind: 'team', id: team.id, members: agents.filter(member => member.id !== root?.id && member.teamId === team.id) }); }
  }
  const owned = (id: string) => nodes.filter(node => node.agentId === id);
  let width: number, height = 0;
  const placeResources = (agent: ResourceUsageAgent, x: number, y: number, column: number) => {
    const items = owned(agent.id);
    items.forEach((node, index) => resourceBoxes.set(node.id, { x, y: y + index * (resourceHeight + rowGap), width: column, height: resourceHeight }));
    return items.length ? y + items.length * (resourceHeight + rowGap) - rowGap : y - rowGap;
  };
  if (!expanded) {
    width = Math.max(160, Math.floor(availableWidth));
    const inner = width - padding * 2, columns = inner >= 274 ? 2 : 1;
    const column = (inner - (columns - 1) * gap) / columns;
    let cursor = 18;
    if (root) {
      const rootWidth = Math.min(220, inner), rootX = (width - rootWidth) / 2;
      agentBoxes.set(root.id, { x: rootX, y: cursor, width: rootWidth, height: agentHeight });
      cursor += agentHeight + rowGap * 2;
      if (owned(root.id).length) cursor = placeResources(root, rootX, cursor, rootWidth) + rowGap * 2;
    }
    const row = (members: readonly ResourceUsageAgent[], y: number) => {
      let bottom = y + agentHeight;
      members.forEach((agent, index) => {
        const x = members.length === 1 ? (width - Math.min(220, inner)) / 2 : padding + index * (column + gap);
        const cardWidth = members.length === 1 ? Math.min(220, inner) : column;
        agentBoxes.set(agent.id, { x, y, width: cardWidth, height: agentHeight });
        bottom = Math.max(bottom, placeResources(agent, x, y + agentHeight + rowGap * 2, cardWidth));
      });
      return bottom + rowGap * 2;
    };
    for (const group of groups) {
      if (group.kind === 'agent') { cursor = row([group.agent], cursor); continue; }
      const teamWidth = Math.min(220, inner);
      teamBoxes.set(group.id, { x: (width - teamWidth) / 2, y: cursor, width: teamWidth, height: agentHeight });
      cursor += agentHeight + rowGap * 2;
      for (let index = 0; index < group.members.length; index += columns) cursor = row(group.members.slice(index, index + columns), cursor);
    }
    height = cursor + padding;
  } else {
    const column = 220, layer = 112, top = 28;
    const columns = [...(root && owned(root.id).length ? [root] : []), ...groups.flatMap(group => group.kind === 'team' ? group.members : [group.agent])];
    width = Math.max(column + padding * 2, columns.length * (column + gap) - gap + padding * 2);
    const hasChildren = groups.length > 0;
    const agentY = top + (root ? layer : 0) + (visibleTeams.length ? layer : 0);
    const depth = (agent: ResourceUsageAgent) => {
      let value = agent, level = 0; const seen = new Set([agent.id]);
      while (value.parentId && byId.has(value.parentId) && !seen.has(value.parentId)) { seen.add(value.parentId); level++; value = byId.get(value.parentId)!; }
      return Math.min(3, Math.max(0, level - (root ? 1 : 0)));
    };
    agents.forEach(agent => {
      const columnX = padding + Math.max(0, columns.findIndex(value => value.id === agent.id)) * (column + gap);
      const y = agent.id === root?.id ? top : (hasChildren ? agentY : top) + depth(agent) * layer;
      const x = agent.id === root?.id ? (width - column) / 2 : columnX;
      agentBoxes.set(agent.id, { x, y, width: column, height: agentHeight });
      const bottom = placeResources(agent, columnX, y + agentHeight + rowGap * 2, column);
      height = Math.max(height, bottom + padding, y + agentHeight + padding);
    });
    for (const team of visibleTeams) {
      const members = agents.filter(agent => agent.teamId === team.id && agent.id !== root?.id);
      const positions = members.map(agent => agentBoxes.get(agent.id)!.x);
      const x = (Math.min(...positions) + Math.max(...positions)) / 2;
      const y = root ? top + layer : top;
      teamBoxes.set(team.id, { x, y, width: column, height: agentHeight });
      height = Math.max(height, y + agentHeight + padding);
    }
  }
  const edges: CanvasEdge[] = [];
  const ownerActive = (id: string) => nodes.some(node => node.agentId === id && node.status === 'active');
  const boxes = [...agentBoxes.values(), ...teamBoxes.values(), ...resourceBoxes.values()];
  // Every relationship leaves its owner's bottom port and enters its child's top port.
  // A later stacked sibling routes around cards, never through a previous resource node.
  const link = (start: CanvasBox, end: CanvasBox): Pick<CanvasEdge, 'path' | 'fromPort' | 'toPort' | 'routing'> => {
    const fromPort = { x: start.x + start.width / 2, y: start.y + start.height };
    const toPort = { x: end.x + end.width / 2, y: end.y };
    const { x: sx, y: sy } = fromPort, { x: ex, y: ey } = toPort;
    const obstacles = boxes.filter(box => box !== start && box !== end);
    const cubic = (a: CanvasPort, b: CanvasPort, c: CanvasPort, d: CanvasPort) => Array.from({ length: 25 }, (_, index) => {
      const t = index / 24, u = 1 - t;
      return { x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
        y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y };
    });
    const collisions = (points: CanvasPort[]) => {
      let total = 0;
      for (const point of points) for (const box of obstacles) if (point.x > box.x - 2 && point.x < box.x + box.width + 2 && point.y > box.y - 2 && point.y < box.y + box.height + 2) total++;
      return total;
    };
    const middle = sy < ey ? (sy + ey) / 2 : Math.max(sy, ey) + 32;
    const direct = `M ${sx} ${sy} C ${sx} ${middle}, ${ex} ${middle}, ${ex} ${ey}`;
    if (ey > sy && !collisions(cubic(fromPort, { x: sx, y: middle }, { x: ex, y: middle }, toPort))) return { path: direct, fromPort, toPort, routing: 'direct' };
    const departure = rowGap, arrival = Math.min(12, rowGap / 2);
    const lanes = [...new Set([start.x - 12, end.x - 12, start.x + start.width + 12, end.x + end.width + 12, 6, width - 6].map(x => Math.max(6, Math.min(width - 6, x))))];
    const candidates = lanes.map(lane => {
      const first = { x: lane, y: sy + departure * 2 }, last = { x: lane, y: ey - arrival * 2 };
      const points = [...cubic(fromPort, { x: sx, y: sy + departure }, { x: lane, y: sy + departure }, first),
        ...cubic(last, { x: lane, y: ey - arrival }, { x: ex, y: ey - arrival }, toPort)];
      const verticalCollisions = obstacles.filter(box => lane > box.x - 2 && lane < box.x + box.width + 2
        && Math.max(first.y, last.y) > box.y - 2 && Math.min(first.y, last.y) < box.y + box.height + 2).length;
      return { path: `M ${sx} ${sy} C ${sx} ${sy + departure}, ${lane} ${sy + departure}, ${lane} ${first.y} L ${lane} ${last.y} C ${lane} ${ey - arrival}, ${ex} ${ey - arrival}, ${ex} ${ey}`,
        score: (collisions(points) + verticalCollisions * 25) * 1_000_000 + Math.abs(sx - lane) + Math.abs(ex - lane) };
    });
    const best = candidates.reduce((result, candidate) => candidate.score < result.score ? candidate : result);
    return { path: best.path, fromPort, toPort, routing: 'outer' };
  };
  const routedTeams = new Map<string, string>();
  for (const team of visibleTeams) {
    const members = agents.filter(agent => agent.teamId === team.id && agent.id !== root?.id);
    const parent = members[0]?.parentId;
    if (parent && byId.get(parent)?.role === 'primary' && members.every(agent => agent.parentId === parent) && agentBoxes.has(parent)) {
      routedTeams.set(team.id, parent);
      edges.push({ id: `parent-team:${parent}:${team.id}`, from: parent, to: team.id, kind: 'parent', ...link(agentBoxes.get(parent)!, teamBoxes.get(team.id)!), active: members.some(agent => ownerActive(agent.id)) });
    }
  }
  for (const agent of agents) {
    const box = agentBoxes.get(agent.id)!;
    if (agent.role !== 'primary' && agent.parentId && agent.parentId !== agent.id && agentBoxes.has(agent.parentId) && (!agent.teamId || routedTeams.get(agent.teamId) !== agent.parentId)) edges.push({ id: `parent:${agent.parentId}:${agent.id}`, from: agent.parentId, to: agent.id, kind: 'parent', ...link(agentBoxes.get(agent.parentId)!, box), active: ownerActive(agent.id) });
    if (agent.id !== root?.id && agent.teamId && teamBoxes.has(agent.teamId)) edges.push({ id: `team:${agent.teamId}:${agent.id}`, from: agent.teamId, to: agent.id, kind: 'team', ...link(teamBoxes.get(agent.teamId)!, box), active: ownerActive(agent.id) });
  }
  for (const node of nodes) {
    const start = agentBoxes.get(node.agentId), end = resourceBoxes.get(node.id); if (!start || !end) continue;
    edges.push({ id: `resource:${node.id}`, from: node.agentId, to: node.id, kind: 'resource', ...link(start, end), active: node.status === 'active' });
  }
  return { width, height: Math.max(expanded ? 360 : 220, height), agentBoxes, teamBoxes, resourceBoxes, edges, rootId: root?.id };
}

function DiagramBody({ graph, copy, language, view, patch, expanded }: {
  graph: ResourceUsageGraph; copy: ResourceUsageCopy; language: string; view: ViewState; patch(value: Partial<ViewState>): void; expanded: boolean;
}) {
  const teamId = graph.teams.some(team => team.id === view.teamId) ? view.teamId : '';
  const filterAgents = graph.agents.filter(agent => !teamId || agent.teamId === teamId);
  const agentId = filterAgents.some(agent => agent.id === view.agentId) ? view.agentId : '';
  const agents = new Map(graph.agents.map(agent => [agent.id, agent]));
  const filtered = graph.nodes.filter(node => (!agentId || node.agentId === agentId) && (!teamId || agents.get(node.agentId)?.teamId === teamId));
  const shown = filtered.slice(0, view.limit);
  const included = new Set(shown.map(node => node.agentId));
  for (const id of [...included]) {
    let parent = agents.get(id)?.parentId; const visited = new Set([id]);
    while (parent && !visited.has(parent) && agents.has(parent)) {
      if (teamId && agents.get(parent)?.teamId !== teamId) break;
      visited.add(parent); included.add(parent); parent = agents.get(parent)?.parentId;
    }
  }
  const visibleAgents = graph.agents.filter(agent => included.has(agent.id));
  const selected = graph.nodes.find(node => node.id === view.selectedId);
  const selectedVisible = selected && filtered.some(node => node.id === selected.id) ? selected : undefined;
  const date = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }), [language]);
  const formatTime = (value: string) => Number.isFinite(Date.parse(value)) ? date.format(new Date(value)) : '—';
  const style = { '--usage-pulse-duration': '.9s', '--usage-flow-duration': '.7s' } as CSSProperties;
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const closeDetail = () => {
    const selectedButton = viewport.current?.querySelector<HTMLButtonElement>('.resource-usage-node-button[aria-pressed="true"]');
    patch({ selectedId: undefined }); selectedButton?.focus({ preventScroll: true });
  };
  return <div className={`resource-usage-body${expanded ? ' is-expanded' : ''}`} style={style}>
    <p className="resource-usage-help">{copy.help}</p>
    <div className="resource-usage-controls">
      {!!graph.teams.length && <label><span>{copy.allTeams}</span><select value={teamId} onChange={event => patch({ teamId: event.currentTarget.value, agentId: '', limit: PAGE_SIZE })}>
        <option value="">{copy.allTeams}</option>{graph.teams.map(team => <option key={team.id} value={team.id}>{team.label}</option>)}
      </select></label>}
      {graph.agents.length > 1 && <label><span>{copy.allAgents}</span><select value={agentId} onChange={event => patch({ agentId: event.currentTarget.value, limit: PAGE_SIZE })}>
        <option value="">{copy.allAgents}</option>{filterAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
      </select></label>}
    </div>
    <div className="resource-usage-layout">
      <div ref={viewport} className="resource-usage-viewport" role="region" aria-label={copy.title} tabIndex={0}
        onPointerDown={event => {
          if (event.button !== 0 || event.target instanceof Element && event.target.closest('button, select, summary, a, input')) return;
          pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.panning = 'true';
        }} onPointerMove={event => {
          const held = pan.current; if (!held || held.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = held.left - (event.clientX - held.x); event.currentTarget.scrollTop = held.top - (event.clientY - held.y);
        }} onPointerUp={event => { pan.current = null; delete event.currentTarget.dataset.panning; }} onPointerCancel={event => { pan.current = null; delete event.currentTarget.dataset.panning; }}>
        {!shown.length ? <p className="resource-usage-empty" role="status"><Icon name="spark" />{copy.empty}</p> : <GraphCanvas key={JSON.stringify([teamId, agentId])} agents={visibleAgents} teams={graph.teams} nodes={shown} copy={copy} expanded={expanded}
          selectedId={selectedVisible?.id} focusedTeam={teamId} onFocusTeam={id => patch({ teamId: id === teamId ? '' : id, agentId: '', limit: PAGE_SIZE })}
          onFocusAgent={id => patch({ agentId: id === agentId ? '' : id, limit: PAGE_SIZE })} onSelect={id => patch({ selectedId: id === view.selectedId ? undefined : id })} />}
      </div>
      {selectedVisible && <ResourceDetail node={selectedVisible} graph={graph} copy={copy} formatTime={formatTime} onClose={closeDetail} />}
    </div>
    {(filtered.length > shown.length || graph.truncated) && <div className="resource-usage-pagination">
      {filtered.length > shown.length && <button type="button" className="button small resource-usage-more" onClick={() => patch({ limit: view.limit + PAGE_SIZE })}>{copy.more} · {copy.nodes(filtered.length - shown.length)}</button>}
      {graph.truncated && <p className="resource-usage-limited">{copy.limited}</p>}
    </div>}
    {!!graph.nodes.length && <details className="resource-usage-trace"><summary>{copy.trace}</summary>
      <ol>{graph.nodes.slice(-TRACE_SIZE).map(node => <li key={node.id}><time dateTime={node.lastAt}>{formatTime(node.lastAt)}</time><span>{agents.get(node.agentId)?.label ?? node.agentId} · {node.label}</span><span className="resource-usage-status" data-status={node.status}>{copy.statuses[node.status]}</span></li>)}</ol>
    </details>}
  </div>;
}

function GraphCanvas({ agents, teams, nodes, copy, expanded, selectedId, focusedTeam, onFocusTeam, onFocusAgent, onSelect }: {
  agents: readonly ResourceUsageAgent[]; teams: ResourceUsageGraph['teams']; nodes: readonly ResourceUsageNode[]; copy: ResourceUsageCopy; expanded: boolean;
  selectedId?: string; focusedTeam: string; onFocusTeam(id: string): void; onFocusAgent(id: string): void; onSelect(id: string): void;
}) {
  const cableId = useId();
  const canvas = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(240);
  const layout = resourceUsageCanvasLayout(agents, teams, nodes, expanded, availableWidth);
  useEffect(() => {
    const viewport = canvas.current?.parentElement; if (!viewport || expanded) return;
    const measure = () => setAvailableWidth(Math.max(160, viewport.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded]);
  useEffect(() => {
    let mounted = true;
    // Child effects can precede the dialog's showModal effect; measure once it opens.
    queueMicrotask(() => {
      if (!mounted) return;
      const element = canvas.current, viewport = element?.parentElement;
      if (element && viewport) viewport.scrollLeft = Math.max(0, (element.offsetWidth - viewport.clientWidth) / 2);
    });
    return () => { mounted = false; };
  }, []);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const ports = new Map<string, CanvasPort & { side: 'top' | 'bottom'; active: boolean }>();
  for (const edge of layout.edges) {
    const input = `in:${edge.to}`, output = `out:${edge.from}`;
    ports.set(output, { ...edge.fromPort, side: 'bottom', active: edge.active || ports.get(output)?.active === true });
    ports.set(input, { ...edge.toPort, side: 'top', active: edge.active || ports.get(input)?.active === true });
  }
  return <div ref={canvas} className="resource-usage-canvas" role="group" aria-label={copy.title} style={{ width: layout.width, height: layout.height }}>
    <svg className="resource-usage-connectors" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
      {layout.edges.map((edge, index) => <g key={edge.id} data-edge-kind={edge.kind} data-from={edge.from} data-to={edge.to} data-active={edge.active || undefined}>
        {edge.active && <defs><linearGradient id={`${cableId}-cable-${index}`} gradientUnits="userSpaceOnUse"
          x1={edge.fromPort.x} y1={edge.fromPort.y} x2={edge.toPort.x} y2={edge.toPort.y}>
          <stop className="resource-usage-cable-start" offset="0" /><stop className="resource-usage-cable-end" offset="1" />
        </linearGradient></defs>}
        <path className="resource-usage-connector" d={edge.path} style={edge.active ? { stroke: `url(#${cableId}-cable-${index})` } : undefined} />
        {edge.active && <><path className="resource-usage-capsule-glow" d={edge.path} pathLength={100} /><path className="resource-usage-capsule" d={edge.path} pathLength={100} /></>}
      </g>)}
    </svg>
    {teams.map(team => {
      const box = layout.teamBoxes.get(team.id); if (!box) return null;
      const members = agents.filter(agent => agent.teamId === team.id && agent.role !== 'primary');
      const active = nodes.some(node => node.status === 'active' && members.some(member => member.id === node.agentId));
      return <div key={`team:${team.id}`} className="resource-usage-team" data-team-id={team.id} data-active={active || undefined} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
        <button type="button" className="resource-usage-team-heading" aria-pressed={focusedTeam === team.id} onClick={() => onFocusTeam(team.id)}>
          <span className="resource-usage-card-icon"><Icon name="users" /></span><strong>{team.label}</strong><span className="resource-usage-team-count">{members.length}</span>
        </button>
      </div>;
    })}
    {agents.map(agent => <AgentBranch key={agent.id} agent={agent} parent={agent.parentId ? byId.get(agent.parentId) : undefined} team={teams.find(team => team.id === agent.teamId)?.label}
      nodes={nodes.filter(node => node.agentId === agent.id)} copy={copy} selectedId={selectedId} onSelect={onSelect} onFocusAgent={onFocusAgent}
      box={layout.agentBoxes.get(agent.id)!} resourceBoxes={layout.resourceBoxes} root={agent.id === layout.rootId} />)}
    {[...ports].map(([id, port]) => <span key={id} className="resource-usage-port" data-port={id} data-side={port.side} data-active={port.active || undefined}
      aria-hidden="true" style={{ left: port.x, top: port.y }} />)}
  </div>;
}

function AgentBranch({ agent, parent, team, nodes, copy, selectedId, onSelect, onFocusAgent, box, resourceBoxes, root }: {
  agent: ResourceUsageAgent; parent?: ResourceUsageAgent; team?: string; nodes: readonly ResourceUsageNode[]; copy: ResourceUsageCopy;
  selectedId?: string; onSelect(id: string): void; onFocusAgent(id: string): void; box: CanvasBox; resourceBoxes: ReadonlyMap<string, CanvasBox>; root: boolean;
}) {
  const roleLabel = agent.role === 'primary' ? copy.mainAgent : agent.role === 'subagent' || agent.parentId || agent.teamId ? copy.subagent : copy.owner;
  return <div className={`resource-usage-agent${root ? ' is-root' : ''}`} role="group" aria-label={agent.label} data-agent-id={agent.id} data-parent-id={agent.parentId} data-resource-active={nodes.some(node => node.status === 'active') || undefined} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
    <button type="button" className="resource-usage-agent-heading" onClick={() => onFocusAgent(agent.id)}>
      <span className="resource-usage-agent-icon"><Icon name={root ? 'mission' : 'users'} /></span>
      <span className="resource-usage-agent-name"><strong title={agent.label}>{agent.label}</strong><small title={[roleLabel, team, parent?.label].filter(Boolean).join(' · ')}>{roleLabel}{team ? ` · ${team}` : ''}</small></span>
      <span className="resource-usage-agent-state" data-status={agent.status}>{agent.status === 'completed' ? copy.agentDone : copy.statuses[agent.status]}</span>
    </button>
    {nodes.map(node => {
      const placed = resourceBoxes.get(node.id)!;
      return <div key={node.id} className="resource-usage-node" data-status={node.status} data-resource-id={node.id} data-kind={node.kind}
        style={{ left: placed.x - box.x, top: placed.y - box.y, width: placed.width, height: placed.height }}>
        <button type="button" className="resource-usage-node-button" aria-pressed={node.id === selectedId} onClick={() => onSelect(node.id)}>
          <span className="resource-usage-node-icon"><Icon name={node.kind === 'skill' ? 'spark' : 'book'} /></span>
          <span className="resource-usage-node-label"><strong title={node.label}>{node.label}</strong><small>{node.kind === 'skill' ? copy.skills : copy.knowledge}</small></span>
          <span className="resource-usage-repeat" aria-label={copy.uses(node.count)}>×{node.count}</span>
          <span className="resource-usage-status" data-status={node.status}>{copy.statuses[node.status]}</span>
        </button>
      </div>;
    })}
  </div>;
}

function ResourceDetail({ node, graph, copy, formatTime, onClose }: { node: ResourceUsageNode; graph: ResourceUsageGraph; copy: ResourceUsageCopy; formatTime(value: string): string; onClose(): void }) {
  const related = node.resourceKey ? graph.nodes.filter(other => other.resourceKey === node.resourceKey) : [node];
  const owners = graph.agents.filter(agent => related.some(other => other.agentId === agent.id));
  return <section className="resource-usage-detail" aria-label={node.label}>
    <header><Icon name={node.kind === 'skill' ? 'spark' : 'book'} /><h4>{node.label}</h4><span className="resource-usage-status" data-status={node.status}>{copy.statuses[node.status]}</span><button type="button" className="icon-button small" aria-label={copy.hideDetails} title={copy.hideDetails} onClick={onClose}><Icon name="close" /></button></header>
    {node.detail && <p className="resource-usage-detail-description">{node.detail}</p>}
    <dl><div><dt>{copy.owner}</dt><dd>{graph.agents.find(agent => agent.id === node.agentId)?.label ?? node.agentId}</dd></div>
      <div><dt>{copy.accessedBy}</dt><dd>{owners.length ? owners.map(agent => <span key={agent.id} className="resource-usage-owner"><Icon name="users" />{agent.label}{agent.teamId && <small>{graph.teams.find(team => team.id === agent.teamId)?.label}</small>}</span>) : node.agentId}</dd></div>
      {node.source && <div><dt>{copy.source}</dt><dd>{node.source}</dd></div>}
      <div><dt>{copy.lastActivity}</dt><dd><time dateTime={node.lastAt}>{formatTime(node.lastAt)}</time></dd></div>
      <div><dt>{copy.uses(node.count)}</dt><dd>×{node.count}</dd></div></dl>
    {!!node.evidenceIds.length && <details className="resource-usage-evidence"><summary>{copy.evidence} · {node.evidenceIds.length}</summary><ul>{node.evidenceIds.slice(-TRACE_SIZE).map(id => <li key={id}><code>{id}</code></li>)}</ul></details>}
  </section>;
}
