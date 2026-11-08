import type { TeamPlan } from '@extalia/platform';
import type { Messages } from '../i18n';

export function PlanningBasisNote({ basis, t }: { basis?: TeamPlan['planningBasis']; t: Messages }) {
  if (!basis) return null;
  return <p className="note small" role="status">{basis.kind === 'guide'
    ? t.modelGuide.basisGuide(basis.title, basis.revision) : basis.kind === 'heuristic' ? t.modelGuide.basisHeuristic : t.modelGuide.basisKnowledge}</p>;
}
