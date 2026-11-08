import type { Workspace } from '@extalia/core';
import type { AgentHostApi, ConnectionView, HostMissionRun, HostState, SessionSummary } from '@extalia/platform';
import { useId, useState } from 'react';
import type { Messages } from '../i18n';
import { MissionComposer } from './MissionComposer';
import { MissionPlanEditor } from './MissionPlanEditor';
import { allowedConnections, type AllowedPairs, type DraftPlan } from './missionModel';

/** Preserve goal choices and plan edits while moving between composition and review. */
export function MissionWorkflow({ t, agents, state, session, workspace, connections, onState, onLaunched }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  session: SessionSummary;
  workspace: Workspace;
  connections?: readonly ConnectionView[];
  onState(next: HostState): void;
  onLaunched(run: HostMissionRun): void;
}) {
  const [proposal, setProposal] = useState<{ draft: DraftPlan; pairs: AllowedPairs; generation: number } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const hintId = useId();
  return <div className="mission-workflow">
    <div hidden={reviewing}>
      <MissionComposer t={t} agents={agents} state={state} session={session} workspace={workspace} onState={onState}
        onPlanned={(draft, pairs) => {
          setProposal(current => ({ draft, pairs, generation: (current?.generation ?? 0) + 1 }));
          setReviewing(true);
        }} />
      {proposal && <div className="card">
        <button type="button" aria-describedby={hintId} onClick={() => setReviewing(true)}>{t.missions.compose.resumePlan}</button>
        <p id={hintId} className="muted small">{t.missions.compose.resumePlanHint}</p>
      </div>}
    </div>
    {proposal && <div hidden={!reviewing}>
      <MissionPlanEditor key={proposal.generation} t={t} agents={agents} session={session}
        connections={connections ?? allowedConnections(state, workspace)} pairs={proposal.pairs} initial={proposal.draft}
        onBack={() => setReviewing(false)} onLaunched={onLaunched} />
    </div>}
  </div>;
}
