/** Bounded synthetic declarative checks. A passing result is not proof of arbitrary task performance. */
export interface SkillLearningEvaluation {
  revisionId: string;
  treeSha256: string;
  baselineRevisionId?: string;
  baselineTreeSha256?: string;
  status: 'passed' | 'failed' | 'insufficient-evidence' | 'stale';
  passed: number;
  total: number;
  baselinePassed?: number;
  evaluatedAt: string;
  scope: 'synthetic-declarative';
  issues?: string[];
}

export interface SkillLearnedQuality {
  complete: boolean;
  missingSections: string[];
  testCount: number;
  baseline?: { revisionId: string; treeSha256: string };
  evaluation?: SkillLearningEvaluation;
}

/** Assertions remain inside the daemon; providers receive only test inputs. */
export interface SkillEvaluationSubject {
  subject: 'candidate' | 'baseline';
  instructions: string;
  references: { path: string; content: string }[];
  cases: { id: string; input: string }[];
}
export interface SkillEvaluationPlan {
  evaluationId: string;
  revisionId: string;
  treeSha256: string;
  baselineRevisionId?: string;
  baselineTreeSha256?: string;
  subjects: SkillEvaluationSubject[];
}
export interface SkillEvaluationEvidence {
  evaluationId: string;
  subjects: { subject: 'candidate' | 'baseline'; outputs: { caseId: string; text: string }[] }[];
  provider: string;
  model: string;
}
