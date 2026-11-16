import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import type { SkillLoadItem } from './transcript';
import './skillLoadCard.css';

/** Quiet host receipts shared by Chat and the Office conversation transcript. */
export function SkillLoadCard({ t, item, language }: { t: Messages; item: SkillLoadItem; language: string }) {
  const p = t.chat.skillLoading;
  const loaded = item.skills.filter(skill => skill.status === 'loaded').length;
  const skipped = item.skills.length - loaded;
  const format = new Intl.NumberFormat(language);
  const owner = item.owner === 'worker' ? p.worker(item.agentLabel ?? item.agentId ?? '')
    : item.owner === 'agent' ? p.agent(item.agentId ?? '') : p.primary;
  return (
    <details className="skill-load-card">
      <summary>
        <span className="skill-load-heading"><Icon name="book" /><span>{p.title}</span></span>
        <span className="skill-load-summary">{p.loaded(loaded)}{skipped > 0 ? ` · ${p.skipped(skipped)}` : ''}</span>
      </summary>
      <div className="skill-load-body">
        <p className="skill-load-owner">{owner}</p>
        <p className="skill-load-help">{loaded > 0 ? p.help : p.noneLoaded}</p>
        <ul className="skill-load-list">
          {item.skills.map((skill, index) => (
            <li key={`${skill.name}:${index}`} className={`skill-load-entry ${skill.status}`}>
              <div className="skill-load-entry-head"><code>{skill.name}</code><span className="skill-load-status">{p.statuses[skill.status]}</span></div>
              <p className="skill-load-reason">{p.reasons[skill.reason]}{skill.intent ? ` · ${p.intents[skill.intent]}` : ''}</p>
              <span className="skill-load-source">{p.sources[skill.source]}{skill.status === 'loaded' ? ` · ${p.entryCharacters(format.format(skill.characters))}` : ''}</span>
            </li>
          ))}
        </ul>
        {item.omitted !== undefined && item.omitted > 0 && <p className="skill-load-help">{p.omitted(format.format(item.omitted))}</p>}
        <p className="skill-load-budget">{p.characters(format.format(item.characters), format.format(item.budgetCharacters))}</p>
      </div>
    </details>
  );
}
