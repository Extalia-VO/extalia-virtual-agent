import type { CharacterAppearances } from '@extalia/core';
import { useLayoutEffect, useRef } from 'react';
import type { Messages } from '../../i18n';
import type { OfficeActivity } from '../activityFeed';
import type { OfficeAgent } from '../presence';
import { AgentPortrait } from './AgentPortrait';
import { forwardWheelToCanvas } from './forwardWheel';
import { currentLine } from './leadBar';
import { agentStatusLabel, statusTone } from './status';

/**
 * Small cards for the lead agents along the bottom-left: portrait from the
 * character's look, status, project and what it is doing now.
 */
export function LeadAgentBar({ t, leads, more, appearances, projects, latest, selectedId, onSelect }: {
  t: Messages; leads: readonly OfficeAgent[]; more: number; appearances: CharacterAppearances;
  projects: ReadonlyMap<string, string>; latest: ReadonlyMap<string, OfficeActivity>; selectedId: string | null;
  onSelect(characterId: string): void;
}) {
  const bar = useRef<HTMLElement>(null);
  // Publishes the cards' height to the stage (`--office-lead-h`) so the prompt dock sits right above them.
  useLayoutEffect(() => {
    const node = bar.current;
    const stage = node?.parentElement;
    if (!node || !stage || typeof ResizeObserver === 'undefined') return;
    const update = () => stage.style.setProperty('--office-lead-h', `${Math.round(node.offsetHeight)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { observer.disconnect(); stage.style.removeProperty('--office-lead-h'); };
  }, [leads.length]);
  if (!leads.length) return null;
  return <section ref={bar} className="office-lead-bar" aria-label={t.officeOverlay.lead.region} onWheel={forwardWheelToCanvas}>
    {leads.map(agent => {
      const tone = statusTone(agent);
      const project = projects.get(agent.id);
      const line = currentLine(t, agent, latest.get(agent.id));
      return <button key={agent.id} type="button" className={`office-lead-card tone-${tone}`} aria-pressed={selectedId === agent.id}
        title={t.officeOverlay.lead.show(agent.displayName)} onClick={() => onSelect(agent.id)}>
        <AgentPortrait characterId={agent.id} appearance={appearances[agent.id]} identity={agent.look} activity={agent} />
        <span className="office-lead-text">
          <strong>{agent.displayName}</strong>
          <span className="office-lead-status"><span className={`office-dot tone-${tone}`} aria-hidden="true" />{agentStatusLabel(t, agent)}{project ? <> · <span className="office-lead-project">{project}</span></> : null}</span>
          {line && <small>{line}</small>}
        </span>
      </button>;
    })}
    {more > 0 && <span className="office-lead-more">{t.officeOverlay.lead.more(more)}</span>}
  </section>;
}
