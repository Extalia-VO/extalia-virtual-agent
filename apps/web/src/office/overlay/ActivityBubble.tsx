import type { SemanticCategory } from '../semanticBubble';
import type { BubbleTone } from '../scene/bubbles';
import { Icon, type IconName } from '../../ui/Icon';
import './activityBubble.css';

// Small, original vector cogs; computed once rather than during each render.
const cogPoints = (teeth: number, radius: number) => Array.from({ length: teeth * 4 }, (_, step) => {
  const angle = step * Math.PI / (teeth * 2) - Math.PI / 2;
  const reach = step % 4 === 1 || step % 4 === 2 ? radius : radius * .76;
  return `${(Math.cos(angle) * reach).toFixed(2)},${(Math.sin(angle) * reach).toFixed(2)}`;
}).join(' ');
const largeCog = cogPoints(8, 5.5), smallCog = cogPoints(6, 4.3);
const actionIcons: Partial<Record<SemanticCategory, IconName>> = {
  git: 'git', review: 'eye', create: 'folder', delete: 'trash', move: 'send',
  copy: 'copy', format: 'edit', build: 'tool', install: 'download', data: 'files',
};

/** Presentation only: the caller supplies a privacy-safe, localized activity phrase. */
export function ActivityBubble({ phrase, category, tone, icon, name, fading, reducedMotion }: {
  phrase: string; category: SemanticCategory; tone: BubbleTone; icon?: IconName | undefined;
  name?: string | undefined; fading: boolean; reducedMotion: boolean;
}) {
  const motion = tone === 'error' || tone === 'speech' ? 'still'
    : tone === 'attention' ? 'waiting'
    : tone === 'handoff' ? 'handoff'
    : category === 'think' || category === 'prompt' ? 'thinking'
    : category === 'command' ? 'terminal'
    : category === 'test' ? 'testing'
    : category === 'search' ? 'searching'
    : category === 'read' ? 'reading'
    : category === 'git' ? 'repository'
    : category === 'edit' ? 'writing'
    : category === 'web' ? 'browsing'
    : category === 'knowledge' ? 'learning'
    : category === 'review' ? 'reviewing'
    : category === 'write' ? 'writing-file'
    : category === 'create' ? 'creating'
    : category === 'delete' ? 'deleting'
    : category === 'move' ? 'moving'
    : category === 'copy' ? 'copying'
    : category === 'format' ? 'formatting'
    : category === 'build' ? 'building'
    : category === 'install' ? 'installing'
    : category === 'data' ? 'processing' : 'working';
  const busy = motion !== 'still' && motion !== 'waiting';
  const spinning = motion === 'thinking' || motion === 'testing' || motion === 'terminal' || motion === 'installing';
  return <div className={`office-character-bubble tone-${tone}${fading ? ' fading' : ''}${reducedMotion ? ' reduced' : ''}`}
    data-motion={motion} role="note" aria-label={name}>
    <span className="office-bubble-symbol" key={category} aria-hidden="true">
      {spinning && <span className="office-bubble-orbit" />}
      {motion === 'working' || motion === 'building' ? <svg className="icon office-bubble-gears" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <g transform="translate(8 8.5)"><g className="office-bubble-gear"><polygon points={largeCog} /><circle r="1.9" /></g></g>
        <g transform="translate(16 15)"><g className="office-bubble-gear small"><polygon points={smallCog} /><circle r="1.4" /></g></g>
      </svg> : motion === 'terminal' ? <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M3 4h18v16H3Z" /><path d="m7 8 3 4-3 4" /><path className="office-bubble-cursor" d="M13 16h4" />
      </svg> : motion === 'writing-file' || motion === 'moving' ? <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M5 2h9l5 5v5M14 2v5h5M5 2v20h7" />
        {motion === 'writing-file' ? <><path d="M8 10h5m-5 4h3" /><path d="m13 18 6-6 3 3-6 6-4 1Z" /></>
          : <path className="office-bubble-file-arrow" d="M11 17h11m-4-4 4 4-4 4" />}
      </svg> : motion === 'processing' ? <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 4 14 4 14 0V5M5 12c0 4 14 4 14 0" />
      </svg> : <Icon name={actionIcons[category] ?? icon ?? 'spark'} />}
    </span>
    <span className="office-bubble-phrase">{phrase}</span>
    {busy && <span className="office-bubble-dots" aria-hidden="true"><i /><i /><i /></span>}
  </div>;
}

/** A decorative greeting after a user pick, separate from real session messages. */
export function CharacterCalloutBubble({ text, variation, name, reducedMotion }: {
  text: string; variation: number; name?: string | undefined; reducedMotion: boolean;
}) {
  return <div className={`office-character-callout variant-${variation % 4}${reducedMotion ? ' reduced' : ''}`}
    role="status" aria-label={name ? `${name}: ${text}` : text}>
    <span className="office-callout-mark" aria-hidden="true"><Icon name={variation % 2 ? 'chat' : 'spark'} /></span>
    <span>{text}</span>
  </div>;
}
