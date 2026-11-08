import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, heuristicMissionPlan, missionPlanPrompt, normalizeModelSelectionGuideInput, normalizeTeamPlanRequest } from '../src/index.js';
import { teamPlanPrompt } from '@extalia/core';

const guide = { title: 'Reference', revision: '1', updatedAt: '2026-01-01T00:00:00.000Z', text: 'Only candidate-model is available. unavailable-model is better but inaccessible.' };
const context = { goal: 'Survey', maxTasks: 1, candidates: [{ connectionId: 'mock', model: 'candidate-model', label: 'Mock', provider: 'openai-chat', lead: true }], modelSelectionGuide: guide };

describe('Model Selection Guide contracts and planning', () => {
  it('registers optional transports and bounds untrusted fields', () => {
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(['getModelSelectionGuide', 'saveModelSelectionGuide']));
    expect(normalizeModelSelectionGuideInput(null)).toBeNull();
    expect(() => normalizeModelSelectionGuideInput({ title: 'x', revision: '', text: 'x', extra: true })).toThrow();
    expect(() => normalizeModelSelectionGuideInput({ title: 'x', revision: '', text: 'x'.repeat(24001) })).toThrow();
  });
  it('uses full guide context without widening mission candidates; fallback source stays explicit', () => {
    expect(missionPlanPrompt(context).user).toContain(guide.text);
    const fallback = heuristicMissionPlan(context);
    expect(fallback.planningBasis).toEqual({ kind: 'heuristic' });
    expect(fallback.source).toBe('heuristic');
    expect(fallback.tasks[0]!.model).toBe('candidate-model');
    expect(missionPlanPrompt({ ...context, modelSelectionGuide: null }).user).toContain('own model knowledge as the primary basis');
  });
  it('drops client-injected guide context while prompt helpers accept the host-owned reference', () => {
    const request = { goal: 'Survey', count: 1, allowedModels: ['candidate-model'], context: { modelSelectionGuide: guide } };
    expect(normalizeTeamPlanRequest(request).context).toBeUndefined();
    expect(teamPlanPrompt(request).user).toContain(guide.text);
    expect(teamPlanPrompt(request).user).toContain('soul/working style');
  });
});
