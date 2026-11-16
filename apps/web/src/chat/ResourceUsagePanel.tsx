import type { AgentTeam } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useMemo } from 'react';
import type { Messages } from '../i18n';
import { ResourceUsageDiagram } from './ResourceUsageDiagram';
import { createResourceUsageProjection } from './resourceUsageGraph';

/** Reuse the already-owned event feed; opening this diagram never starts a host/provider request. */
export function ResourceUsagePanel({ events, sessionId, scopeKey, team, t, language, live = true, primaryName }: {
  events: readonly ExtaliaEvent[]; sessionId: string; scopeKey: string; team?: AgentTeam | null;
  t: Messages; language: string; live?: boolean; primaryName?: string;
}) {
  const project = useMemo(() => createResourceUsageProjection({ scopeKey, sessionId, team, primaryName,
    primaryLabel: t.chat.skillLoading.primary, teamLabel: t.team.title }), [scopeKey, sessionId, team, primaryName, t]);
  const graph = project(events);
  const visible = useMemo(() => live ? graph : { ...graph,
    agents: graph.agents.map(agent => agent.status === 'active' ? { ...agent, status: 'unknown' as const } : agent),
    nodes: graph.nodes.map(node => node.status === 'active' ? { ...node, status: 'unknown' as const } : node),
  }, [graph, live]);
  const copy = useMemo(() => live ? t.resourceUsage : { ...t.resourceUsage, help: t.resourceUsage.pausedHelp }, [t, live]);
  return <ResourceUsageDiagram graph={visible} copy={copy} language={language} visible={live && graph.nodes.some(node => node.status === 'active')} />;
}
