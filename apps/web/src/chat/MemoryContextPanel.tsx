import type { Workspace } from '@extalia/core';
import type { AgentHostApi, ConnectionView, HostState, SessionContextUsage, SessionSummary } from '@extalia/platform';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Messages } from '../i18n';
import { contextLabel } from '../office/overlay/contextLabel';
import { Icon } from '../ui/Icon';
import { WorkspaceMemoryPanel } from './WorkspaceMemoryPanel';
import './memoryContext.css';

type MemoryConnection = Pick<ConnectionView, 'id' | 'name' | 'features'>;

/** Saved sessions retain their own connection; only a new conversation uses the workspace default. */
export function memoryContextScope(state: Pick<HostState, 'connections' | 'profile' | 'dataDirectory' | 'storage' | 'host'>, workspace: Workspace, session?: SessionSummary) {
  if (session ? session.control !== 'managed' || session.runtime || session.workspaceId !== workspace.id : workspace.runtimeId === 'hermes') return undefined;
  const connectionId = session ? session.connectionId : workspace.providerProfileId;
  const profileKey = JSON.stringify([state.profile.id, state.dataDirectory ?? state.storage.dataDirectory, state.host.kind]);
  return {
    connection: state.connections.find(connection => connection.id === connectionId),
    context: session?.context,
    key: JSON.stringify([profileKey, workspace.id, session?.id ?? 'new', connectionId ?? 'unknown']),
    draftKey: JSON.stringify([profileKey, workspace.id]),
  };
}

/** Native disclosure gives keyboard and touch users the same facts as the context ring. */
export function MemoryContextPanel({ t, language, id, detailsRef, workspaceName, connection, context, onOpenSettings, onOpenSkills, onOpenKnowledge, agents, workspaceId, ownerKey, draftKey }: {
  t: Messages;
  language: string;
  id: string;
  detailsRef?: Ref<HTMLDetailsElement>;
  workspaceName: string;
  agents?: AgentHostApi;
  workspaceId?: string;
  ownerKey?: string;
  draftKey?: string;
  connection?: MemoryConnection | undefined;
  context?: SessionContextUsage | undefined;
  onOpenSettings(): void;
  onOpenSkills(): void;
  onOpenKnowledge?: (() => void) | undefined;
}) {
  const m = t.memoryContext;
  const root = useRef<HTMLDetailsElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  useImperativeHandle(detailsRef, () => root.current!, []);
  const memoryOwner = connection?.features.memory ?? 'unknown';
  const skillsOwner = connection?.features.skills ?? 'unknown';
  const shown = context ? contextLabel(context, t) : undefined;
  const sampled = context && Number.isFinite(Date.parse(context.updatedAt)) ? new Date(context.updatedAt) : undefined;
  return <details ref={root} id={id} className="memory-context" onToggle={event => {
    const open = event.currentTarget.open;
    setExpanded(open); if (open) setOpened(true);
  }}>
    <summary onClick={() => { if (root.current?.open) setExpanded(false); }}>
      <span className="memory-context-title"><Icon name="book" />{m.title}</span>
      <span className="memory-context-preview">{m.memory}: {m.owners[memoryOwner]} · {shown?.value ?? m.noReadingShort}</span>
    </summary>
    <div className="memory-context-body" role="region" aria-label={m.title} tabIndex={0}>
      <dl className="memory-context-facts">
        <div><dt>{m.workspace}</dt><dd>{workspaceName}</dd></div>
        <div><dt>{m.connection}</dt><dd>{connection?.name ?? m.connectionUnknown}</dd></div>
        <div><dt>{m.memory}</dt><dd>{m.owners[memoryOwner]}</dd></div>
        <div><dt>{m.skills}</dt><dd>{m.owners[skillsOwner]}</dd></div>
      </dl>
      <p>{m.memoryModes[memoryOwner]}</p>
      {memoryOwner === 'extalia' && <p>{m.workspaceNotes}</p>}
      {skillsOwner === 'extalia' && <p>{m.extaliaSkills}</p>}
      <section className="memory-context-reading" aria-label={m.latestRequest}>
        <h3>{m.latestRequest}</h3>
        {context && shown ? <>
          <p className={`context-usage tone-${shown.tone}`}><strong>{shown.value}</strong></p>
          <p>{context.estimated ? t.context.estimated : m.reported}</p>
          {!context.windowTokens && <p>{t.context.unknownWindow}</p>}
          {shown.tone !== 'normal' && <p>{t.context[shown.tone]}</p>}
          <p>{context.compactions > 0 ? t.context.compactions(context.compactions) : m.noCompactions}</p>
          {sampled && <p className="muted">{m.sampled}: <time dateTime={context.updatedAt}>{sampled.toLocaleString(language)}</time></p>}
        </> : <p>{m.noReading}</p>}
        <p className="muted">{m.contextHint}</p>
      </section>
      <p className="muted">{m.connectionScope}</p>
      <div className="memory-context-actions">
        <button type="button" className="button small" onClick={onOpenSettings}>{m.settings}</button>
        <button type="button" className="button small" onClick={onOpenSkills}>{m.openSkills}</button>
        {onOpenKnowledge && <button type="button" className="button small" onClick={onOpenKnowledge}>{m.openKnowledge}</button>}
      </div>
      {opened && agents && workspaceId && ownerKey && draftKey && <WorkspaceMemoryPanel t={t} agents={agents} workspaceId={workspaceId} ownerKey={ownerKey} draftKey={draftKey}
        active={expanded} isOpen={() => root.current?.open === true} />}
    </div>
  </details>;
}
