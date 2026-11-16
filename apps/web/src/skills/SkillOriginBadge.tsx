import type { Messages } from '../i18n';
import type { SkillBookOrigin } from './skillLibraryModel';

export function SkillOriginBadge({ origin, t }: { origin: SkillBookOrigin; t: Messages }) {
  return <span className="skill-origin-badge" data-origin={origin} title={t.skillLibrary.originHints[origin]}>{t.skillLibrary.origins[origin]}</span>;
}
