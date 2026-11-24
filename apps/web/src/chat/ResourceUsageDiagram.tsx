import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  PanOnScrollMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnNodesChange,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import type { ResourceUsageAgent, ResourceUsageCopy, ResourceUsageGraph, ResourceUsageNode } from './resourceUsageTypes';
import './resourceUsageDiagram.css';

const PAGE_SIZE = 32;
const TRACE_SIZE = 12;

interface ViewState { agentId: string; teamId: string; selectedId?: string; selectedAgentId?: string; limit: number }
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
  const padding = expanded ? 40 : 20, gap = expanded ? 44 : 16;
  const agentHeight = expanded ? 72 : 60, resourceHeight = expanded ? 80 : 68, rowGap = expanded ? 28 : 16;
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
    const cardWidth = Math.max(120, width - padding * 2);
    const cardX = (width - cardWidth) / 2;
    let cursor = 16;
    if (root) {
      agentBoxes.set(root.id, { x: cardX, y: cursor, width: cardWidth, height: agentHeight });
      cursor += agentHeight + rowGap * 2;
      if (owned(root.id).length) cursor = placeResources(root, cardX, cursor, cardWidth) + rowGap * 2;
    }
    const row = (agent: ResourceUsageAgent, y: number) => {
      agentBoxes.set(agent.id, { x: cardX, y, width: cardWidth, height: agentHeight });
      const bottom = Math.max(y + agentHeight, placeResources(agent, cardX, y + agentHeight + rowGap * 2, cardWidth));
      return bottom + rowGap * 2;
    };
    for (const group of groups) {
      if (group.kind === 'agent') { cursor = row(group.agent, cursor); continue; }
      teamBoxes.set(group.id, { x: cardX, y: cursor, width: cardWidth, height: agentHeight });
      cursor += agentHeight + rowGap * 2;
      for (const member of group.members) cursor = row(member, cursor);
    }
    height = cursor + padding;
  } else {
    const column = 236, layer = 122, top = 32;
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
  // A later stacked sibling routes smoothly around cards, never through a previous resource node.
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
    const departure = rowGap, arrival = Math.min(14, rowGap / 2);
    const lanes = [...new Set([start.x - 16, end.x - 16, start.x + start.width + 16, end.x + end.width + 16, 8, width - 8].map(x => Math.max(8, Math.min(width - 8, x))))];
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

export interface AgentFlowNodeData extends Record<string, unknown> {
  agent: ResourceUsageAgent;
  parent?: ResourceUsageAgent;
  team?: string;
  copy: ResourceUsageCopy;
  root: boolean;
  active: boolean;
  selected: boolean;
  hasTopPort: boolean;
  hasBottomPort: boolean;
  topPortActive: boolean;
  bottomPortActive: boolean;
  onSelectAgent(id: string): void;
}

export interface TeamFlowNodeData extends Record<string, unknown> {
  team: { id: string; label: string };
  memberCount: number;
  active: boolean;
  focused: boolean;
  hasTopPort: boolean;
  hasBottomPort: boolean;
  topPortActive: boolean;
  bottomPortActive: boolean;
  onFocusTeam(id: string): void;
}

export interface ResourceFlowNodeData extends Record<string, unknown> {
  node: ResourceUsageNode;
  copy: ResourceUsageCopy;
  selected: boolean;
  hasTopPort: boolean;
  topPortActive: boolean;
  onSelect(id: string): void;
}

export interface ResourceFlowEdgeData extends Record<string, unknown> {
  kind: CanvasEdge['kind'];
  from: string;
  to: string;
  active: boolean;
  selected: boolean;
  routing: CanvasEdge['routing'];
  laneOffset: number;
  customPath: string;
  fromPort: CanvasPort;
  toPort: CanvasPort;
  moved: boolean;
}

export type AgentFlowNodeType = Node<AgentFlowNodeData, 'agent'>;
export type TeamFlowNodeType = Node<TeamFlowNodeData, 'team'>;
export type ResourceFlowNodeType = Node<ResourceFlowNodeData, 'resource'>;
export type ResourceUsageFlowNode = AgentFlowNodeType | TeamFlowNodeType | ResourceFlowNodeType;
export type ResourceUsageFlowEdge = Edge<ResourceFlowEdgeData, 'resourceEdge'>;

export interface BuildResourceUsageFlowParams {
  agents: readonly ResourceUsageAgent[];
  teams: ResourceUsageGraph['teams'];
  nodes: readonly ResourceUsageNode[];
  copy: ResourceUsageCopy;
  expanded: boolean;
  availableWidth?: number;
  selectedId?: string;
  selectedAgentId?: string;
  focusedTeam: string;
  positions?: ReadonlyMap<string, XYPosition>;
  onFocusTeam(id: string): void;
  onSelectAgent(id: string): void;
  onSelect(id: string): void;
}

/** Build typed `@xyflow/react` nodes and edges from deterministic layout geometry plus user drag positions. */
export function buildResourceUsageFlow(params: BuildResourceUsageFlowParams) {
  const { agents, teams, nodes, copy, expanded, availableWidth = 280, selectedId, selectedAgentId, focusedTeam, positions, onFocusTeam, onSelectAgent, onSelect } = params;
  const layout = resourceUsageCanvasLayout(agents, teams, nodes, expanded, availableWidth);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const flowIdFor = (entityId: string, kind: 'agent' | 'team' | 'resource') => `${kind}:${entityId}`;
  const incoming = new Map<string, boolean>(), outgoing = new Map<string, boolean>();
  const resolveFlowSource = (edge: CanvasEdge) => edge.kind === 'team' ? flowIdFor(edge.from, 'team') : flowIdFor(edge.from, 'agent');
  const resolveFlowTarget = (edge: CanvasEdge) => edge.kind === 'resource' ? flowIdFor(edge.to, 'resource')
    : layout.teamBoxes.has(edge.to) ? flowIdFor(edge.to, 'team') : flowIdFor(edge.to, 'agent');

  for (const edge of layout.edges) {
    const source = resolveFlowSource(edge), target = resolveFlowTarget(edge);
    outgoing.set(source, edge.active || outgoing.get(source) === true);
    incoming.set(target, edge.active || incoming.get(target) === true);
  }

  const flowNodes: ResourceUsageFlowNode[] = [];

  for (const team of teams) {
    const box = layout.teamBoxes.get(team.id);
    if (!box) continue;
    const id = flowIdFor(team.id, 'team');
    const members = agents.filter(agent => agent.teamId === team.id && agent.role !== 'primary');
    const active = nodes.some(node => node.status === 'active' && members.some(member => member.id === node.agentId));
    const hasTopPort = incoming.has(id), hasBottomPort = outgoing.has(id);
    const position = positions?.get(id) ?? { x: box.x, y: box.y };
    flowNodes.push({
      id,
      type: 'team',
      position,
      width: box.width,
      height: box.height,
      initialWidth: box.width,
      initialHeight: box.height,
      draggable: true,
      selectable: false,
      connectable: false,
      focusable: false,
      handles: [
        ...(hasTopPort ? [{ id: 'in', type: 'target' as const, position: Position.Top, x: box.width / 2, y: 0, width: 10, height: 10 }] : []),
        ...(hasBottomPort ? [{ id: 'out', type: 'source' as const, position: Position.Bottom, x: box.width / 2, y: box.height, width: 10, height: 10 }] : []),
      ],
      data: {
        team,
        memberCount: members.length,
        active,
        focused: focusedTeam === team.id,
        hasTopPort,
        hasBottomPort,
        topPortActive: incoming.get(id) === true,
        bottomPortActive: outgoing.get(id) === true,
        onFocusTeam,
      },
    });
  }

  for (const agent of agents) {
    const box = layout.agentBoxes.get(agent.id);
    if (!box) continue;
    const id = flowIdFor(agent.id, 'agent');
    const ownedNodes = nodes.filter(node => node.agentId === agent.id);
    const active = ownedNodes.some(node => node.status === 'active');
    const hasTopPort = incoming.has(id), hasBottomPort = outgoing.has(id);
    const position = positions?.get(id) ?? { x: box.x, y: box.y };
    flowNodes.push({
      id,
      type: 'agent',
      position,
      width: box.width,
      height: box.height,
      initialWidth: box.width,
      initialHeight: box.height,
      draggable: true,
      selectable: false,
      connectable: false,
      focusable: false,
      handles: [
        ...(hasTopPort ? [{ id: 'in', type: 'target' as const, position: Position.Top, x: box.width / 2, y: 0, width: 10, height: 10 }] : []),
        ...(hasBottomPort ? [{ id: 'out', type: 'source' as const, position: Position.Bottom, x: box.width / 2, y: box.height, width: 10, height: 10 }] : []),
      ],
      data: {
        agent,
        parent: agent.parentId ? byId.get(agent.parentId) : undefined,
        team: teams.find(team => team.id === agent.teamId)?.label,
        copy,
        root: agent.id === layout.rootId,
        active,
        selected: agent.id === selectedAgentId,
        hasTopPort,
        hasBottomPort,
        topPortActive: incoming.get(id) === true,
        bottomPortActive: outgoing.get(id) === true,
        onSelectAgent,
      },
    });
  }

  for (const node of nodes) {
    const box = layout.resourceBoxes.get(node.id);
    if (!box) continue;
    const id = flowIdFor(node.id, 'resource');
    const hasTopPort = incoming.has(id);
    const position = positions?.get(id) ?? { x: box.x, y: box.y };
    flowNodes.push({
      id,
      type: 'resource',
      position,
      width: box.width,
      height: box.height,
      initialWidth: box.width,
      initialHeight: box.height,
      draggable: true,
      selectable: false,
      connectable: false,
      focusable: false,
      handles: hasTopPort ? [{ id: 'in', type: 'target' as const, position: Position.Top, x: box.width / 2, y: 0, width: 10, height: 10 }] : [],
      data: {
        node,
        copy,
        selected: node.id === selectedId,
        hasTopPort,
        topPortActive: incoming.get(id) === true,
        onSelect,
      },
    });
  }

  const flowEdges: ResourceUsageFlowEdge[] = layout.edges.map(edge => {
    const source = resolveFlowSource(edge);
    const target = resolveFlowTarget(edge);
    const moved = Boolean(positions?.has(source) || positions?.has(target));
    const selected = Boolean((selectedId && edge.to === selectedId) || (selectedAgentId && (edge.from === selectedAgentId || edge.to === selectedAgentId)));
    return {
      id: edge.id,
      source,
      target,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'resourceEdge',
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      zIndex: edge.active || selected ? 2 : 0,
      data: {
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        active: edge.active,
        selected,
        routing: edge.routing,
        laneOffset: expanded ? 136 : 112,
        customPath: edge.path,
        fromPort: edge.fromPort,
        toPort: edge.toPort,
        moved,
      },
    };
  });

  return { layout, flowNodes, flowEdges };
}

export function TeamFlowNode({ data }: NodeProps<TeamFlowNodeType>) {
  return <div className="resource-usage-team" data-team-id={data.team.id} data-active={data.active || undefined}>
    {data.hasTopPort && <Handle id="in" type="target" position={Position.Top} isConnectable={false} className="resource-usage-port" data-side="top" data-active={data.topPortActive || undefined} />}
    <button type="button" className="resource-usage-team-heading" aria-pressed={data.focused} onClick={() => data.onFocusTeam(data.team.id)}>
      <span className="resource-usage-card-icon"><Icon name="users" /></span>
      <strong>{data.team.label}</strong>
      <span className="resource-usage-team-count">{data.memberCount}</span>
    </button>
    {data.hasBottomPort && <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} className="resource-usage-port" data-side="bottom" data-active={data.bottomPortActive || undefined} />}
  </div>;
}

export function AgentFlowNode({ data }: NodeProps<AgentFlowNodeType>) {
  const { agent, parent, team, copy, root, active, selected } = data;
  const roleLabel = agent.role === 'primary' ? copy.mainAgent : agent.role === 'subagent' || agent.parentId || agent.teamId ? copy.subagent : copy.owner;
  return <div className={`resource-usage-agent${root ? ' is-root' : ''}`} role="group" aria-label={agent.label} data-agent-id={agent.id} data-parent-id={agent.parentId} data-resource-active={active || undefined}>
    {data.hasTopPort && <Handle id="in" type="target" position={Position.Top} isConnectable={false} className="resource-usage-port" data-side="top" data-active={data.topPortActive || undefined} />}
    <button type="button" className="resource-usage-agent-heading" aria-pressed={selected} onClick={() => data.onSelectAgent(agent.id)}>
      <span className="resource-usage-agent-icon"><Icon name={root ? 'mission' : 'users'} /></span>
      <span className="resource-usage-agent-name"><strong title={agent.label}>{agent.label}</strong><small title={[roleLabel, team, parent?.label].filter(Boolean).join(' · ')}>{roleLabel}{team ? ` · ${team}` : ''}</small></span>
      <span className="resource-usage-agent-state" data-status={agent.status}>{agent.status === 'completed' ? copy.agentDone : copy.statuses[agent.status]}</span>
    </button>
    {data.hasBottomPort && <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} className="resource-usage-port" data-side="bottom" data-active={data.bottomPortActive || undefined} />}
  </div>;
}

export function ResourceFlowNode({ data }: NodeProps<ResourceFlowNodeType>) {
  const { node, copy, selected } = data;
  return <div className="resource-usage-node" data-status={node.status} data-resource-id={node.id} data-kind={node.kind}>
    {data.hasTopPort && <Handle id="in" type="target" position={Position.Top} isConnectable={false} className="resource-usage-port" data-side="top" data-active={data.topPortActive || undefined} />}
    <button type="button" className="resource-usage-node-button" aria-pressed={selected} onClick={() => data.onSelect(node.id)}>
      <span className="resource-usage-node-icon"><Icon name={node.kind === 'skill' ? 'spark' : 'book'} /></span>
      <span className="resource-usage-node-label"><strong title={node.label}>{node.label}</strong><small>{node.kind === 'skill' ? copy.skills : copy.knowledge}</small></span>
      <span className="resource-usage-repeat" aria-label={copy.uses(node.count)}>×{node.count}</span>
      <span className="resource-usage-status" data-status={node.status}>{copy.statuses[node.status]}</span>
    </button>
  </div>;
}

export function ResourceFlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<ResourceUsageFlowEdge>) {
  const rawId = useId();
  const gradientId = `${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}-cable`;
  const [bezierPath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.42 });
  const useOuter = data?.routing === 'outer' && !data.moved && Boolean(data.customPath);
  const edgePath = useOuter ? data!.customPath : bezierPath;
  const fromPort = useOuter ? data!.fromPort : { x: sourceX, y: sourceY };
  const toPort = useOuter ? data!.toPort : { x: targetX, y: targetY };
  const active = data?.active === true;
  const selected = data?.selected === true;
  return <g data-edge-kind={data?.kind} data-from={data?.from} data-to={data?.to} data-active={active || undefined} data-selected={selected || undefined}>
    {active && <defs><linearGradient id={gradientId} gradientUnits="userSpaceOnUse"
      x1={fromPort.x} y1={fromPort.y} x2={toPort.x} y2={toPort.y}>
      <stop className="resource-usage-cable-start" offset="0" /><stop className="resource-usage-cable-end" offset="1" />
    </linearGradient></defs>}
    <BaseEdge id={id} path={edgePath} className="resource-usage-connector" style={active ? { stroke: `url(#${gradientId})` } : undefined} interactionWidth={0} />
    {active && <><path className="resource-usage-capsule-glow" d={edgePath} pathLength={100} /><path className="resource-usage-capsule" d={edgePath} pathLength={100} /></>}
  </g>;
}

const NODE_TYPES: NodeTypes = {
  agent: AgentFlowNode,
  team: TeamFlowNode,
  resource: ResourceFlowNode,
};

const EDGE_TYPES: EdgeTypes = {
  resourceEdge: ResourceFlowEdge,
};

function FlowAutoFit({ fitKey, expanded, layoutWidth, layoutHeight, container }: {
  fitKey: string; expanded: boolean; layoutWidth: number; layoutHeight: number; container: RefObject<HTMLDivElement | null>;
}) {
  const { fitView, setViewport } = useReactFlow();
  const initialized = useRef(false);
  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = initialized.current && !reduced ? 200 : 0;
    const run = () => {
      const viewportWidth = container.current?.clientWidth || layoutWidth;
      const viewportHeight = container.current?.clientHeight || 310;
      if (!expanded) {
        // Fit left-to-right at readable scale and let the user scroll vertically through stacked nodes.
        const zoom = Math.min(1, Math.max(0.5, viewportWidth / Math.max(1, layoutWidth)));
        const x = Math.round((viewportWidth - layoutWidth * zoom) / 2);
        void setViewport({ x, y: 0, zoom }, { duration });
      } else {
        const widthZoom = (viewportWidth - 32) / Math.max(1, layoutWidth);
        const heightZoom = (viewportHeight - 32) / Math.max(1, layoutHeight);
        if (Math.min(widthZoom, heightZoom) >= 0.72) {
          void fitView({ padding: 0.1, maxZoom: 1, minZoom: 0.55, duration });
        } else {
          const zoom = Math.min(1, Math.max(0.72, widthZoom));
          const x = Math.round((viewportWidth - layoutWidth * zoom) / 2);
          void setViewport({ x, y: 12, zoom }, { duration });
        }
      }
      initialized.current = true;
    };
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : 0;
    if (!frame) run();
    return () => { if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); };
  }, [fitKey, expanded, layoutWidth, layoutHeight, container, fitView, setViewport]);
  return null;
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
  const selectedAgent = !selectedVisible && view.selectedAgentId ? visibleAgents.find(agent => agent.id === view.selectedAgentId) : undefined;
  const date = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }), [language]);
  const formatTime = (value: string) => Number.isFinite(Date.parse(value)) ? date.format(new Date(value)) : '—';
  const style = { '--usage-pulse-duration': '.9s', '--usage-flow-duration': '.7s' } as CSSProperties;
  const viewport = useRef<HTMLDivElement>(null);
  const closeDetail = () => {
    const selectedButton = viewport.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    patch({ selectedId: undefined, selectedAgentId: undefined });
    selectedButton?.focus({ preventScroll: true });
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
      <div ref={viewport} className="resource-usage-viewport" role="region" aria-label={copy.title}>
        {!shown.length ? <p className="resource-usage-empty" role="status"><Icon name="spark" />{copy.empty}</p> : <GraphCanvas key={JSON.stringify([teamId, agentId, expanded])} agents={visibleAgents} teams={graph.teams} nodes={shown} copy={copy} expanded={expanded}
          selectedId={selectedVisible?.id} selectedAgentId={selectedAgent?.id} focusedTeam={teamId}
          onFocusTeam={id => patch({ teamId: id === teamId ? '' : id, agentId: '', limit: PAGE_SIZE })}
          onSelectAgent={id => patch({ selectedId: undefined, selectedAgentId: id === view.selectedAgentId ? undefined : id })}
          onSelect={id => patch({ selectedAgentId: undefined, selectedId: id === view.selectedId ? undefined : id })} />}
      </div>
      {selectedVisible && <ResourceDetail node={selectedVisible} graph={graph} copy={copy} formatTime={formatTime} onClose={closeDetail} />}
      {selectedAgent && <AgentDetail agent={selectedAgent} graph={graph} copy={copy} onSelectResource={id => patch({ selectedAgentId: undefined, selectedId: id })} onClose={closeDetail} />}
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

function GraphCanvas({ agents, teams, nodes, copy, expanded, selectedId, selectedAgentId, focusedTeam, onFocusTeam, onSelectAgent, onSelect }: {
  agents: readonly ResourceUsageAgent[]; teams: ResourceUsageGraph['teams']; nodes: readonly ResourceUsageNode[]; copy: ResourceUsageCopy; expanded: boolean;
  selectedId?: string; selectedAgentId?: string; focusedTeam: string; onFocusTeam(id: string): void; onSelectAgent(id: string): void; onSelect(id: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(240);
  const [positions, setPositions] = useState<Map<string, XYPosition>>(() => new Map());

  useEffect(() => {
    const viewport = container.current?.parentElement;
    if (!viewport || expanded) return;
    const measure = () => setAvailableWidth(Math.max(160, viewport.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded]);

  const guardedSelect = useCallback((id: string) => { if (!dragging) onSelect(id); }, [dragging, onSelect]);
  const guardedSelectAgent = useCallback((id: string) => { if (!dragging) onSelectAgent(id); }, [dragging, onSelectAgent]);
  const guardedFocusTeam = useCallback((id: string) => { if (!dragging) onFocusTeam(id); }, [dragging, onFocusTeam]);

  const onNodesChange = useCallback<OnNodesChange<ResourceUsageFlowNode>>(changes => {
    const moved = changes.getByType('position').filter(change => Boolean(change.position));
    if (!moved.length) return;
    setPositions(previous => {
      const next = new Map(previous);
      for (const change of moved) next.set(change.id, change.position!);
      return next;
    });
  }, []);

  const onNodeDragStart = useCallback(() => { setDragging(true); }, []);
  const onNodeDragStop = useCallback(() => { setTimeout(() => setDragging(false), 0); }, []);

  const { layout, flowNodes, flowEdges } = useMemo(
    () => buildResourceUsageFlow({
      agents, teams, nodes, copy, expanded, availableWidth, selectedId, selectedAgentId, focusedTeam, positions,
      onFocusTeam: guardedFocusTeam, onSelectAgent: guardedSelectAgent, onSelect: guardedSelect,
    }),
    [agents, teams, nodes, copy, expanded, availableWidth, selectedId, selectedAgentId, focusedTeam, positions, guardedFocusTeam, guardedSelectAgent, guardedSelect],
  );
  const fitKey = `${expanded}:${focusedTeam}:${availableWidth}:${agents.map(agent => agent.id).join(',')}:${nodes.length}`;

  return <div ref={container} className="resource-usage-canvas">
    <ReactFlowProvider initialWidth={layout.width} initialHeight={layout.height} initialNodes={flowNodes} initialEdges={flowEdges}>
      <ReactFlow
        className="resource-usage-flow"
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodeDragThreshold={5}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitView={expanded}
        fitViewOptions={{ padding: 0.1, maxZoom: 1, minZoom: 0.55 }}
        minZoom={expanded ? 0.3 : 0.6}
        maxZoom={1.75}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={expanded}
        panOnScroll={!expanded}
        panOnScrollMode={expanded ? PanOnScrollMode.Free : PanOnScrollMode.Vertical}
        preventScrolling
        translateExtent={expanded ? undefined : [[-40, -24], [layout.width + 40, Math.max(layout.height + 40, 360)]]}
        proOptions={{ hideAttribution: true }}
        aria-label={copy.title}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.25} color="var(--usage-dot)" />
        <FlowAutoFit fitKey={fitKey} expanded={expanded} layoutWidth={layout.width} layoutHeight={layout.height} container={container} />
        {expanded && <Controls showInteractive={false} position="bottom-left" />}
      </ReactFlow>
    </ReactFlowProvider>
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

function AgentDetail({ agent, graph, copy, onSelectResource, onClose }: {
  agent: ResourceUsageAgent; graph: ResourceUsageGraph; copy: ResourceUsageCopy; onSelectResource(id: string): void; onClose(): void;
}) {
  const roleLabel = agent.role === 'primary' ? copy.mainAgent : agent.role === 'subagent' || agent.parentId || agent.teamId ? copy.subagent : copy.owner;
  const teamLabel = agent.teamId ? graph.teams.find(team => team.id === agent.teamId)?.label : undefined;
  const ownedNodes = graph.nodes.filter(node => node.agentId === agent.id);
  return <section className="resource-usage-detail" aria-label={agent.label}>
    <header><Icon name={agent.role === 'primary' ? 'mission' : 'users'} /><h4>{agent.label}</h4><span className="resource-usage-status" data-status={agent.status}>{agent.status === 'completed' ? copy.agentDone : copy.statuses[agent.status]}</span><button type="button" className="icon-button small" aria-label={copy.hideDetails} title={copy.hideDetails} onClick={onClose}><Icon name="close" /></button></header>
    <p className="resource-usage-detail-description">{[roleLabel, teamLabel].filter(Boolean).join(' · ')}</p>
    {!!ownedNodes.length && <div className="resource-usage-detail-list">
      {ownedNodes.map(node => <button key={node.id} type="button" className="resource-usage-detail-item" onClick={() => onSelectResource(node.id)}>
        <Icon name={node.kind === 'skill' ? 'spark' : 'book'} />
        <span className="resource-usage-detail-item-label">{node.label}</span>
        <span className="resource-usage-repeat">×{node.count}</span>
        <span className="resource-usage-status" data-status={node.status}>{copy.statuses[node.status]}</span>
      </button>)}
    </div>}
  </section>;
}
