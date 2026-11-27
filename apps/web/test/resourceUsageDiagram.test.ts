import type * as React from 'react';
import type * as ReactDom from 'react-dom';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlow, type EdgeProps, type NodeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFlowNode,
  ResourceFlowEdge,
  ResourceFlowNode,
  ResourceUsageDiagram,
  TeamFlowNode,
  buildResourceUsageFlow,
  resourceUsageCanvasLayout,
  type AgentFlowNodeType,
  type ResourceFlowNodeType,
  type ResourceUsageFlowEdge,
  type ResourceUsageFlowNode,
  type TeamFlowNodeType,
} from '../src/chat/ResourceUsageDiagram';
import type { ResourceUsageCopy, ResourceUsageGraph, ResourceUsageNode } from '../src/chat/resourceUsageTypes';

const hooks = vi.hoisted(() => ({ index: 0, states: [] as unknown[], effects: [] as (() => void | (() => void))[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next; }]; },
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.states[index] ??= { current: initial }; },
  useEffect: (run: () => void | (() => void)) => { hooks.effects.push(run); },
  useId: () => 'resource-usage-test',
}));
vi.mock('react-dom', async original => ({ ...await original<typeof ReactDom>(), createPortal: (node: ReactNode) => node }));

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const invoke = (node: Element) => {
  const component = typeof node.type === 'function' ? node.type : (node.type as unknown as { type: (props: Record<string, unknown>) => ReactNode }).type;
  return (component as (props: Record<string, unknown>) => ReactNode)(node.props);
};
const copy: ResourceUsageCopy = { title: 'Live resources', expand: 'Expand diagram', close: 'Close diagram', hideDetails: 'Hide resource details', allAgents: 'All agents', allTeams: 'All teams',
  skills: 'Skills', knowledge: 'Knowledge', empty: 'No resource evidence yet', evidence: 'Evidence', owner: 'Owner', mainAgent: 'Main agent', subagent: 'Subagent', agentDone: 'Done', accessedBy: 'Accessed by',
  source: 'Source', lastActivity: 'Last activity', trace: 'Trace', limited: 'Evidence is bounded', help: 'Loaded does not prove use', more: 'Show more',
  uses: count => `${count} recorded uses`, nodes: count => `${count} nodes`, statuses: { loaded: 'Loaded', active: 'Active', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown' } };
const resource = (id: string, extra: Partial<ResourceUsageNode> = {}): ResourceUsageNode => ({ id, agentId: 'lead', kind: 'skill', label: 'Project review', status: 'loaded', count: 1,
  lastAt: '2026-01-01T00:00:00Z', source: 'registry', evidenceIds: [`${id}-receipt`], ...extra });
const graph = (): ResourceUsageGraph => ({ scopeKey: 'session-a:turn-a', teams: [{ id: 'team-a', label: 'Review team' }, { id: 'team-b', label: 'Build team' }],
  agents: [{ id: 'lead', label: 'Lead reviewer', status: 'active', role: 'primary' }, { id: 'reviewer', parentId: 'lead', teamId: 'team-a', label: 'Researcher', status: 'active' },
    { id: 'builder', parentId: 'lead', teamId: 'team-b', label: 'Builder', status: 'waiting' }],
  nodes: [resource('lead-skill', { resourceKey: 'skill:registry:review:v1' }), resource('worker-skill', { agentId: 'reviewer', resourceKey: 'skill:registry:review:v1', status: 'active', count: 3 }),
    resource('worker-knowledge', { agentId: 'reviewer', kind: 'knowledge', label: 'Project decisions', status: 'completed', detail: 'Read exact project note', source: 'notes/decisions.md', resourceKey: 'knowledge:notes/decisions.md' }),
    resource('builder-skill', { agentId: 'builder', status: 'waiting', label: 'Build checks' })], truncated: false });

const renderAgentNode = (node: AgentFlowNodeType) => AgentFlowNode({ id: node.id, type: 'agent', data: node.data, dragging: false, isConnectable: false, selected: false, zIndex: 0, positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y } as NodeProps<AgentFlowNodeType>);
const renderTeamNode = (node: TeamFlowNodeType) => TeamFlowNode({ id: node.id, type: 'team', data: node.data, dragging: false, isConnectable: false, selected: false, zIndex: 0, positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y } as NodeProps<TeamFlowNodeType>);
const renderResourceNode = (node: ResourceFlowNodeType) => ResourceFlowNode({ id: node.id, type: 'resource', data: node.data, dragging: false, isConnectable: false, selected: false, zIndex: 0, positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y } as NodeProps<ResourceFlowNodeType>);
const renderFlowEdge = (edge: ResourceUsageFlowEdge) => ResourceFlowEdge({
  id: edge.id, source: edge.source, target: edge.target, data: edge.data, selected: false,
  sourceX: edge.data!.fromPort.x, sourceY: edge.data!.fromPort.y, targetX: edge.data!.toPort.x, targetY: edge.data!.toPort.y,
  sourcePosition: Position.Bottom, targetPosition: Position.Top,
} as EdgeProps<ResourceUsageFlowEdge>);

function harness(value = graph(), visible?: boolean) {
  const props = { graph: value, copy, language: 'en', visible };
  const draw = () => { hooks.index = 0; return invoke(ResourceUsageDiagram(props) as Element); };
  const body = () => invoke(nodes(draw()).find(node => typeof node.type === 'function' && 'graph' in node.props && 'patch' in node.props)!);
  const canvas = () => invoke(nodes(body()).find(node => typeof node.type === 'function' && 'agents' in node.props && 'nodes' in node.props)!);
  const flow = () => nodes(canvas()).find(node => node.type === ReactFlow)!;
  const flowNodes = () => (flow().props.nodes as ResourceUsageFlowNode[]);
  const flowEdges = () => (flow().props.edges as ResourceUsageFlowEdge[]);
  const agentNodes = () => flowNodes().filter((node): node is AgentFlowNodeType => node.type === 'agent');
  const teamNodes = () => flowNodes().filter((node): node is TeamFlowNodeType => node.type === 'team');
  const resourceNodes = () => flowNodes().filter((node): node is ResourceFlowNodeType => node.type === 'resource');
  const select = (id: string) => {
    const match = resourceNodes().find(node => node.data.node.id === id);
    if (!match) throw new Error(`Missing node ${id}`);
    const button = nodes(renderResourceNode(match)).find(node => node.type === 'button')!;
    (button.props.onClick as () => void)();
  };
  const detail = () => nodes(body()).find(node => typeof node.type === 'function' && 'node' in node.props && 'formatTime' in node.props);
  const filter = (label: string, value: string) => {
    const field = nodes(body()).find(node => node.type === 'label' && text(node).startsWith(label))!;
    const select = nodes(field).find(node => node.type === 'select')!;
    (select.props.onChange as (event: unknown) => void)({ currentTarget: { value } });
  };
  return { props, draw, body, canvas, flow, flowNodes, flowEdges, agentNodes, teamNodes, resourceNodes, select, detail, filter };
}
beforeEach(() => { hooks.index = 0; hooks.states = []; hooks.effects = []; });
afterEach(() => vi.unstubAllGlobals());

describe('live resource usage diagram', () => {
  it('hides an inactive widget while letting an already-open popup show final receipts', () => {
    const h = harness(graph(), false);
    expect(h.draw()).toBeNull();
    h.props.visible = true;
    const open = nodes(h.draw()).find(node => node.type === 'button' && node.props['aria-label'] === copy.expand)!;
    (open.props.onClick as () => void)();
    h.props.visible = false;
    expect((h.draw() as Element).props.hidden).toBe(true);
    const modal = nodes(h.draw()).find(node => typeof node.type === 'function' && 'returnFocusRef' in node.props)!;
    expect(modal).toBeDefined();
    (modal.props.onClose as () => void)();
    expect(h.draw()).toBeNull();
  });

  it('toggles a selected resource closed and exposes a dedicated detail close button', () => {
    const h = harness();
    h.select('worker-skill'); expect(h.detail()).toBeDefined();
    h.select('worker-skill'); expect(h.detail()).toBeUndefined();
    h.select('worker-skill');
    const close = nodes(invoke(h.detail()!)).find(node => node.type === 'button' && node.props['aria-label'] === copy.hideDetails)!;
    (close.props.onClick as () => void)();
    expect(h.detail()).toBeUndefined();
  });

  it('uses endpoint gradients only for live React Flow cables, including zero-width vertical paths', () => {
    const h = harness();
    const layout = resourceUsageCanvasLayout(h.props.graph.agents, h.props.graph.teams, h.props.graph.nodes, false, 240);
    const edges = h.flowEdges();
    expect(edges.length).toBeGreaterThan(0);
    for (const flowEdge of edges) {
      const rendered = renderFlowEdge(flowEdge);
      const group = nodes(rendered).find(node => node.type === 'g' && node.props['data-edge-kind'])!;
      const gradient = nodes(group).find(node => node.type === 'linearGradient');
      const baseEdge = nodes(group).find(node => node.props.className === 'resource-usage-connector')!;
      if (!group.props['data-active']) {
        expect(gradient).toBeUndefined(); expect(baseEdge.props.style).toBeUndefined(); continue;
      }
      const edge = layout.edges.find(item => item.from === group.props['data-from'] && item.to === group.props['data-to'])!;
      expect(gradient?.props).toMatchObject({ gradientUnits: 'userSpaceOnUse', x1: edge.fromPort.x, y1: edge.fromPort.y, x2: edge.toPort.x, y2: edge.toPort.y });
      expect(baseEdge.props.style).toEqual({ stroke: `url(#${gradient!.props.id})` });
      expect(nodes(group).some(node => node.props.className === 'resource-usage-capsule')).toBe(true);
    }
    h.props.graph = { ...h.props.graph, nodes: h.props.graph.nodes.map(node => ({ ...node, status: 'completed' })) };
    for (const flowEdge of h.flowEdges()) {
      const rendered = renderFlowEdge(flowEdge);
      expect(nodes(rendered).some(node => node.type === 'linearGradient')).toBe(false);
      expect(nodes(rendered).some(node => node.props.className === 'resource-usage-capsule')).toBe(false);
    }
  });

  it('renders React Flow nodes, handles and factual status attributes without turning loaded receipts into activity', () => {
    const value = graph(), html = renderToStaticMarkup(createElement(ResourceUsageDiagram, { graph: value, copy, language: 'en' }));
    expect(html).toContain('react-flow');
    expect(html).toContain('react-flow__node');
    expect(html).toContain('react-flow__handle');
    expect(html).toContain('data-resource-id="lead-skill"'); expect(html).toContain('data-resource-id="worker-skill"');
    expect(html).toMatch(/data-status="loaded" data-resource-id="lead-skill"/);
    expect(html).toMatch(/data-status="active" data-resource-id="worker-skill"/);
    for (const label of ['Lead reviewer', 'Researcher', 'Review team', 'Loaded does not prove use', '3 recorded uses']) expect(html).toContain(label);
    expect(html).toContain('data-parent-id="lead"');
    expect(html).not.toContain('<textarea'); expect(html).not.toContain('<form');
    expect(html).toContain('--usage-pulse-duration:.9s');
    const h = harness(value);
    const lead = h.agentNodes().find(node => node.data.agent.id === 'lead')!;
    expect(nodes(renderAgentNode(lead)).find(node => node.props['data-agent-id'] === 'lead')?.props['data-resource-active']).toBeUndefined();
    const teamA = h.teamNodes().find(node => node.data.team.id === 'team-a')!;
    const teamB = h.teamNodes().find(node => node.data.team.id === 'team-b')!;
    expect(nodes(renderTeamNode(teamA)).find(node => node.props['data-team-id'] === 'team-a')?.props['data-active']).toBe(true);
    expect(nodes(renderTeamNode(teamB)).find(node => node.props['data-team-id'] === 'team-b')?.props['data-active']).toBeUndefined();
    expect(h.flow().props.nodesDraggable).toBe(true);
    expect(h.flow().props.nodesConnectable).toBe(false);
    expect(h.flow().props.fitView).toBe(false);
    expect(h.flow().props.defaultViewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(h.flow().props.panOnScroll).toBe(true);
    expect(h.flow().props.panOnScrollMode).toBe('vertical');
    expect(h.flow().props.proOptions).toEqual({ hideAttribution: true });
    expect(html).not.toContain('react-flow__minimap');
  });

  it('shows AgentDetail without hiding other nodes when clicking an agent, and jumps cleanly to ResourceDetail', () => {
    const h = harness();
    const reviewer = h.agentNodes().find(node => node.data.agent.id === 'reviewer')!;
    const agentButton = nodes(renderAgentNode(reviewer)).find(node => node.type === 'button')!;
    (agentButton.props.onClick as () => void)();
    expect(h.agentNodes().map(node => node.data.agent.id)).toEqual(['lead', 'reviewer', 'builder']);
    const agentDetail = nodes(h.body()).find(node => typeof node.type === 'function' && 'agent' in node.props && 'onSelectResource' in node.props)!;
    expect(agentDetail).toBeDefined();
    const renderedDetail = invoke(agentDetail);
    expect(text(renderedDetail)).toContain('Researcher');
    expect(text(renderedDetail)).toContain('Project decisions');
    const itemButton = nodes(renderedDetail).find(node => node.props.className === 'resource-usage-detail-item' && text(node).includes('Project decisions'))!;
    (itemButton.props.onClick as () => void)();
    expect(h.detail()?.props.node).toMatchObject({ id: 'worker-knowledge' });
  });

  it('opens exact resource details and lists only explicitly shared resource accessors', () => {
    const h = harness(); h.select('worker-skill');
    let detail = invoke(h.detail()!);
    expect(text(detail)).toContain('Researcher'); expect(text(detail)).toContain('Lead reviewer'); expect(text(detail)).toContain('Review team');
    expect(text(detail)).not.toContain('Builder');
    expect(text(detail)).toContain('worker-skill-receipt');
    h.props.graph = { ...h.props.graph, nodes: [...h.props.graph.nodes, resource('same-generic-label', { agentId: 'builder' })] };
    h.select('same-generic-label'); detail = invoke(h.detail()!);
    expect(text(detail)).toContain('Builder'); expect(text(detail)).not.toContain('Lead reviewer'); expect(text(detail)).not.toContain('Researcher');
  });

  it('preserves selection and input order across reuse and completion without resetting team focus', () => {
    const h = harness(); h.filter(copy.allTeams, 'team-a'); h.select('worker-skill');
    h.props.graph = { ...h.props.graph, nodes: h.props.graph.nodes.map(node => node.id === 'worker-skill' ? { ...node, count: 4, status: 'completed' as const } : node).concat(resource('new-resource', { agentId: 'reviewer' })) };
    const detail = h.detail()!;
    expect(detail.props.node).toMatchObject({ id: 'worker-skill', count: 4, status: 'completed' });
    expect(h.agentNodes().map(node => node.data.agent.id)).toEqual(['reviewer']);
    expect(h.resourceNodes().map(node => node.data.node.id)).toEqual(['worker-skill', 'worker-knowledge', 'new-resource']);
    h.filter(copy.allAgents, 'reviewer');
    expect(h.detail()?.props.node).toMatchObject({ id: 'worker-skill' });
    h.filter(copy.allTeams, 'team-b'); expect(h.detail()).toBeUndefined();
    expect(h.agentNodes().map(node => node.data.agent.id)).toEqual(['builder']);
  });

  it('groups only actual team membership and focuses that team without assigning unknown delegates', () => {
    const value = graph();
    value.agents.push({ id: 'nested', label: 'Nested delegate', parentId: 'reviewer', status: 'active' });
    value.nodes.push(resource('nested-resource', { agentId: 'nested' }));
    const h = harness(value), team = h.teamNodes().find(node => node.data.team.id === 'team-a')!;
    const layout = resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, false);
    expect(layout.edges.filter(edge => edge.kind === 'team' && edge.from === 'team-a').map(edge => edge.to)).toEqual(['reviewer']);
    const nested = h.agentNodes().find(node => node.data.agent.id === 'nested')!;
    expect(nested.data.parent).toMatchObject({ id: 'reviewer' });
    expect(nested.data.team).toBeUndefined();
    const focus = nodes(renderTeamNode(team)).find(node => node.type === 'button')!;
    (focus.props.onClick as () => void)();
    expect(h.agentNodes().map(node => node.data.agent.id)).toEqual(['reviewer']);
    const focusedTeam = h.teamNodes().find(node => node.data.team.id === 'team-a')!;
    expect(nodes(renderTeamNode(focusedTeam)).find(node => node.props.className === 'resource-usage-team-heading')?.props['aria-pressed']).toBe(true);
  });

  it('lays out spatial cards and curved actual-ownership edges with stable owner columns', () => {
    const value = graph(), compact = resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, false);
    expect(compact.teamBoxes.get('team-a')!.y).toBeGreaterThan(compact.agentBoxes.get('lead')!.y);
    const expanded = resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, true);
    expect(expanded.agentBoxes.get('reviewer')!.x).not.toBe(expanded.agentBoxes.get('builder')!.x);
    expect(compact.resourceBoxes.get('worker-skill')!.y).toBeGreaterThan(compact.agentBoxes.get('reviewer')!.y);
    expect(compact.edges.filter(edge => edge.kind === 'resource').every(edge => value.agents.some(agent => agent.id === edge.from))).toBe(true);
    expect(compact.edges.filter(edge => edge.kind === 'team' && edge.from === 'team-a').map(edge => edge.to)).toEqual(['reviewer']);
    expect(compact.edges.some(edge => edge.kind === 'parent' && edge.from === 'lead' && edge.to === 'team-a')).toBe(true);
    expect(compact.edges.find(edge => edge.kind === 'resource' && edge.to === 'lead-skill')?.active).toBe(false);
    expect(compact.edges.find(edge => edge.kind === 'resource' && edge.to === 'worker-skill')?.active).toBe(true);
    expect(compact.edges.every(edge => edge.path.includes('C '))).toBe(true);
    const appended = resourceUsageCanvasLayout(value.agents, value.teams, [...value.nodes, resource('new-skill', { agentId: 'lead' })], false);
    expect(appended.resourceBoxes.get('worker-skill')!.y).toBeGreaterThan(compact.resourceBoxes.get('worker-skill')!.y);
    const appendedExpanded = resourceUsageCanvasLayout(value.agents, value.teams, [...value.nodes, resource('new-skill', { agentId: 'lead' })], true);
    expect(appendedExpanded.resourceBoxes.get('worker-skill')).toEqual(expanded.resourceBoxes.get('worker-skill'));
    expect(appended.resourceBoxes.get('lead-skill')).toEqual(compact.resourceBoxes.get('lead-skill'));
    expect(resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, true).agentBoxes.get('reviewer')!.width).toBeGreaterThanOrEqual(220);
    const teamOnly = resourceUsageCanvasLayout(value.agents.filter(agent => agent.teamId === 'team-a'), value.teams, value.nodes.filter(node => node.agentId === 'reviewer'), true);
    expect(teamOnly.rootId).toBeUndefined();
    expect(teamOnly.teamBoxes.get('team-a')!.y).toBeLessThan(teamOnly.agentBoxes.get('reviewer')!.y);
    expect(teamOnly.edges.some(edge => edge.kind === 'parent')).toBe(false);
  });

  it('builds prefixed React Flow nodes and edges with explicit handles for every port', () => {
    const value = graph();
    const { flowNodes, flowEdges } = buildResourceUsageFlow({
      agents: value.agents, teams: value.teams, nodes: value.nodes, copy, expanded: true,
      focusedTeam: '', onFocusTeam: vi.fn(), onSelectAgent: vi.fn(), onSelect: vi.fn(),
    });
    expect(flowNodes.map(node => node.id)).toContain('agent:lead');
    expect(flowNodes.map(node => node.id)).toContain('team:team-a');
    expect(flowNodes.map(node => node.id)).toContain('resource:worker-skill');
    expect(flowEdges.every(edge => edge.sourceHandle === 'out' && edge.targetHandle === 'in' && edge.type === 'resourceEdge')).toBe(true);
    const workerEdge = flowEdges.find(edge => edge.target === 'resource:worker-skill')!;
    expect(workerEdge.source).toBe('agent:reviewer');
    expect(workerEdge.data?.active).toBe(true);
    const leadNode = flowNodes.find(node => node.id === 'agent:lead')!;
    expect(leadNode.handles?.some(handle => handle.id === 'out' && handle.type === 'source')).toBe(true);
  });

  it('fits narrow rails without scaling text or inventing a main agent from a standalone owner', () => {
    const value = graph();
    for (const width of [218, 240, 280, 320]) {
      const layout = resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, false, width);
      expect(layout.width).toBe(width);
      for (const box of [...layout.agentBoxes.values(), ...layout.teamBoxes.values(), ...layout.resourceBoxes.values()]) {
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.width).toBe(width - 40);
      }
      expect(layout.edges.some(edge => edge.kind === 'parent' && edge.from === 'lead' && edge.to === 'reviewer')).toBe(false);
      expect(layout.edges.filter(edge => edge.kind === 'parent' && edge.to === 'team-a')).toHaveLength(1);
    }
    const unknown = { id: 'unknown-worker', label: 'Unknown worker', status: 'loaded' as const };
    expect(resourceUsageCanvasLayout([unknown], [], [resource('unknown-resource', { agentId: unknown.id })], false, 240).rootId).toBeUndefined();
  });

  it('connects a single child directly from the owner bottom port to its top center', () => {
    const agent = { id: 'owner', label: 'Owner', role: 'primary' as const, status: 'completed' as const };
    const only = resource('only', { agentId: agent.id });
    for (const expanded of [false, true]) {
      const layout = resourceUsageCanvasLayout([agent], [], [only], expanded, 240);
      const owner = layout.agentBoxes.get(agent.id)!, child = layout.resourceBoxes.get(only.id)!;
      const edge = layout.edges[0]!;
      expect(edge).toMatchObject({ from: 'owner', to: 'only', routing: 'direct', active: false,
        fromPort: { x: owner.x + owner.width / 2, y: owner.y + owner.height }, toPort: { x: child.x + child.width / 2, y: child.y } });
      expect(edge.fromPort.x).toBe(edge.toPort.x);
      expect(edge.path).not.toContain(' L ');
      expect(edge.path.endsWith(`${edge.toPort.x} ${child.y}`)).toBe(true);
    }
    const value = graph(); value.agents[0]!.status = 'completed';
    const h = harness(value), lead = h.agentNodes().find(node => node.data.agent.id === 'lead')!;
    expect(text(renderAgentNode(lead))).toContain('Done');
    expect(lead.handles?.length).toBeGreaterThan(0);
  });

  it('fans out actual ownership edges through top ports and routes stacked siblings around cards', () => {
    const value = graph();
    for (const expanded of [false, true]) {
      const layout = resourceUsageCanvasLayout(value.agents, value.teams, value.nodes, expanded, 240);
      const first = layout.edges.find(edge => edge.to === 'worker-skill')!, sibling = layout.edges.find(edge => edge.to === 'worker-knowledge')!;
      expect(first.routing).toBe('direct'); expect(sibling.routing).toBe('outer');
      expect(first.from).toBe('reviewer'); expect(sibling.from).toBe('reviewer');
      for (const edge of layout.edges) {
        const target = layout.agentBoxes.get(edge.to) ?? layout.teamBoxes.get(edge.to) ?? layout.resourceBoxes.get(edge.to)!;
        expect(edge.toPort).toEqual({ x: target.x + target.width / 2, y: target.y });
        expect(edge.path.endsWith(`${edge.toPort.x} ${edge.toPort.y}`)).toBe(true);
      }
      expect(layout.edges.some(edge => value.nodes.some(node => node.id === edge.from))).toBe(false);
    }
  });

  it('uses scope identity to reset modal/filter ownership for a new conversation or turn', () => {
    const props = { graph: graph(), copy, language: 'en' };
    expect((ResourceUsageDiagram(props) as Element).key).toBe('session-a:turn-a');
    expect((ResourceUsageDiagram({ ...props, graph: { ...props.graph, scopeKey: 'session-b:turn-a' } }) as Element).key).toBe('session-b:turn-a');
  });

  it('bounds mounted resource nodes and trace history while allowing explicit incremental expansion', () => {
    const value = graph(); value.nodes = Array.from({ length: 100 }, (_, index) => resource(`skill-${index}`)); value.truncated = true;
    const h = harness(value);
    expect(h.resourceNodes()).toHaveLength(32);
    const more = nodes(h.body()).find(node => node.props.className === 'button small resource-usage-more')!;
    (more.props.onClick as () => void)();
    expect(h.resourceNodes()).toHaveLength(64);
    expect(text(h.body())).toContain(copy.limited);
    const trace = nodes(h.body()).find(node => node.props.className === 'resource-usage-trace')!;
    expect(nodes(trace).filter(node => node.type === 'li')).toHaveLength(12);
  });

  it('shows an honest empty state with the fixed reference 3× motion and no speed setting', () => {
    const value = graph(); value.nodes = [];
    const h = harness(value); expect(text(h.body())).toContain(copy.empty);
    expect(nodes(h.body()).filter(node => node.type === 'label').some(node => /speed|motion/i.test(text(node)))).toBe(false);
    expect((h.body() as Element).props.style).toMatchObject({ '--usage-pulse-duration': '.9s', '--usage-flow-duration': '.7s' });
    expect(h.props.graph.nodes).toEqual([]);
  });

  it('opens a live native modal and restores focus after close with Escape and exterior backdrop handling', () => {
    vi.stubGlobal('document', { body: {} });
    const h = harness();
    const open = nodes(h.draw()).find(node => node.type === 'button' && node.props['aria-label'] === copy.expand)!;
    (open.props.onClick as () => void)();
    const modal = nodes(h.draw()).find(node => typeof node.type === 'function' && 'returnFocusRef' in node.props)!;
    const onClose = vi.fn(), restore = { isConnected: true, focus: vi.fn(), closest: () => null, getClientRects: () => [{}] };
    hooks.index = 0; hooks.states = []; hooks.effects = [];
    const tree = invoke({ ...modal, props: { ...modal.props, onClose, returnFocusRef: { current: restore } } });
    const dialog = nodes(tree).find(node => node.type === 'dialog')!;
    const native = { open: false, showModal: vi.fn(function(this: { open: boolean }) { this.open = true; }), close: vi.fn(), getBoundingClientRect: () => ({ left: 10, right: 300, top: 10, bottom: 500 }) };
    (dialog.props.ref as { current: unknown }).current = native;
    const close = nodes(tree).find(node => node.type === 'button')!;
    const focus = vi.fn(); (close.props.ref as { current: unknown }).current = { focus };
    const cleanup = hooks.effects[0]!();
    expect(native.showModal).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dialog.props['aria-modal']).toBe('true');
    const escape = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (dialog.props.onKeyDown as (event: unknown) => void)(escape);
    expect(escape.stopPropagation).toHaveBeenCalledOnce(); expect(escape.preventDefault).not.toHaveBeenCalled();
    const tab = { key: 'Tab', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (dialog.props.onKeyDown as (event: unknown) => void)(tab);
    expect(tab.stopPropagation).not.toHaveBeenCalled(); expect(tab.preventDefault).not.toHaveBeenCalled();
    const cancel = { preventDefault: vi.fn() };
    (dialog.props.onCancel as (event: unknown) => void)(cancel); expect(cancel.preventDefault).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();
    (dialog.props.onClick as (event: unknown) => void)({ target: native, currentTarget: native, clientX: 50, clientY: 50 }); expect(onClose).not.toHaveBeenCalled();
    (dialog.props.onClick as (event: unknown) => void)({ target: native, currentTarget: native, clientX: 5, clientY: 5 }); expect(onClose).toHaveBeenCalledOnce();
    if (cleanup) cleanup(); expect(native.close).toHaveBeenCalledOnce(); expect(restore.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(modal.props.children).toBeTruthy();
  });
});
