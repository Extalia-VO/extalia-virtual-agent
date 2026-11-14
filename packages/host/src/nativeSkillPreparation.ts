import type { SkillLoadReport } from '@extalia/protocol';
import { checkRequestBudget, RequestBudgetError, type TurnOptions } from '@extalia/runtime';
import { bindRequestSkills, type AgentSkillCatalog } from './skills.js';
import { autoLoadSkills, relevantSkillNames } from './skillAutoLoad.js';

interface Options {
  catalog: AgentSkillCatalog;
  enabled: boolean;
  orchestrator: () => boolean;
  worker?: boolean;
  inputTokenLimit?: number;
  report: (value: SkillLoadReport) => Promise<unknown> | void;
  assertCurrent?: () => void;
}

/** Per-invocation metadata dedupe only; instructions and registry reads stay fresh. */
export function createNativeSkillPreparation(options: Options): NonNullable<TurnOptions['prepareRequest']> {
  let previous: string | undefined;
  return async request => {
    if (request.requestScope) bindRequestSkills(options.catalog, request.requestScope, []);
    request.signal.throwIfAborted();
    options.assertCurrent?.();
    if (!options.enabled) return request.system;
    const userMessages = request.messages.filter(message => message.role === 'user').map(message => message.text);
    const prompt = userMessages.at(-1) ?? '';
    const recent = userMessages.slice(Math.max(0, userMessages.length - 3), -1);
    const append = (context: string) => context ? `${request.system}\n\n${context}` : request.system;
    let rejectedBudget: ReturnType<typeof checkRequestBudget> | undefined;
    const selection = { prompt, recentUserMessages: recent, orchestrator: options.orchestrator(), worker: options.worker, signal: request.signal };
    const result = await autoLoadSkills(options.catalog, {
      ...selection,
      acceptContext: context => {
        const budget = checkRequestBudget({ system: append(context), messages: request.messages, tools: request.tools }, options.inputTokenLimit);
        if (budget.reason) rejectedBudget = budget;
        return !budget.reason;
      },
    });
    request.signal.throwIfAborted();
    options.assertCurrent?.();
    const signature = JSON.stringify(result.report);
    if (signature !== previous) {
      await options.report(result.report);
      request.signal.throwIfAborted();
      options.assertCurrent?.();
      previous = signature;
    }
    if (result.mandatoryFailed) {
      if (result.report.skills.some(skill => ['default-memory', 'configured-team'].includes(skill.reason) && skill.status === 'unavailable'))
        throw new Error('Required Native skill instructions are unavailable.');
      throw new RequestBudgetError(rejectedBudget?.reason ?? 'token-limit', rejectedBudget?.pressure);
    }
    if (request.requestScope) bindRequestSkills(options.catalog, request.requestScope, relevantSkillNames(options.catalog, selection));
    return append(result.context);
  };
}
