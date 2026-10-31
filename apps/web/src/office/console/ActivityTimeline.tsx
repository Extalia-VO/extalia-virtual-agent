import type { Messages } from '../../i18n';
import { markdownPreview } from '../../chat/markdownParser';
import { Icon, type IconName } from '../../ui/Icon';
import { activityText } from '../activityFeed';
import { formatDuration, type TeamMember, type TimelineEntry } from './timeline';

const ICON: Record<TimelineEntry['kind'], IconName> = { prompt: 'chat', notice: 'spark', reply: 'chat', tool: 'tool', delegated: 'users', approval: 'shield', turn: 'check' };

/** A character's steps, newest first, plus the workers its lead agent delegated to. */
export function ActivityTimeline({ t, language, entries, team, onSelectCharacter }: {
  t: Messages; language: string; entries: readonly TimelineEntry[]; team: readonly TeamMember[]; onSelectCharacter?: (characterId: string) => void;
}) {
  const time = new Intl.DateTimeFormat(language, { timeStyle: 'short' });
  const c = t.characterConsole;
  return <div className="character-activity">
    {team.length > 0 && <section className="character-team" aria-label={c.team}>
      <h3>{c.team}</h3>
      <ul>{team.map(member => <li key={member.characterId}>
        <button type="button" className="character-team-member" disabled={!onSelectCharacter} onClick={() => onSelectCharacter?.(member.characterId)}>
          <span className={`office-agent-dot status-${member.state}`} aria-hidden="true" /><span>{member.label}</span><small>{t.chat.status[member.state]}</small>
        </button>
      </li>)}</ul>
    </section>}
    {!entries.length ? <p className="muted-note">{c.noActivity}</p> : <ol className="character-timeline">
      {[...entries].reverse().map(entry => {
        const failed = (entry.kind === 'notice' && entry.failed) || (entry.kind === 'tool' && entry.status === 'failed') || (entry.kind === 'turn' && !entry.ok) || (entry.kind === 'approval' && entry.decision === 'rejected');
        return <li key={entry.id} className={`timeline-${entry.kind} ${failed ? 'failed' : ''}`}>
          <Icon name={entry.kind === 'turn' && !entry.ok ? 'alert' : ICON[entry.kind]} />
          <div>
            <p>
              <strong>{c.kinds[entry.kind]}</strong>
              {entry.kind === 'tool' && <span className={`badge ${entry.status === 'ok' ? 'ok' : entry.status === 'failed' ? 'error' : ''}`}>{c.toolStatus[entry.status]}</span>}
              {entry.kind === 'approval' && <span className={`badge ${entry.decision === 'granted' ? 'ok' : entry.decision === 'rejected' ? 'error' : 'warn'}`}>{c.decision[entry.decision]}</span>}
            </p>
            <p className="timeline-text">
              {entry.kind === 'reply' ? activityText(markdownPreview(entry.text) || entry.text, 220)
                : entry.kind === 'prompt' || entry.kind === 'notice' ? activityText(entry.text, 220)
                : entry.kind === 'tool' || entry.kind === 'delegated' ? entry.label
                  : entry.kind === 'approval' ? entry.action
                    : entry.text ? activityText(entry.text, 220) : entry.ok ? c.turnDone : c.turnFailed}
            </p>
            <small>
              {time.format(new Date(entry.at))}
              {(entry.kind === 'tool' || entry.kind === 'turn') && entry.durationMs !== undefined && ` · ${formatDuration(entry.durationMs)}`}
              {entry.kind === 'turn' && entry.usage && ` · ${c.tokens(entry.usage.inputTokens ?? 0, entry.usage.outputTokens ?? 0)}`}
            </small>
          </div>
        </li>;
      })}
    </ol>}
  </div>;
}
