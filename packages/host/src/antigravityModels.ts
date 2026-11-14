import { EFFORTS, type Effort } from '@extalia/core';
import { isModelId } from '@extalia/platform';

export interface AntigravityModelVariant {
  modelId: string;
  baseModel: string;
  effort?: Effort;
  planModel?: string;
}

export interface AntigravityModelCatalog {
  variants: AntigravityModelVariant[];
  models: string[];
  modelEfforts: Partial<Record<string, Effort[]>>;
  defaultModel?: string;
  defaultEffort?: Effort;
}

export interface AntigravityModelConfigPayload {
  clientModelConfigs?: Array<{
    modelId?: unknown;
    disabled?: unknown;
    modelOrAlias?: { model?: unknown; alias?: unknown };
    quotaInfo?: { remainingFraction?: unknown } | null;
  }>;
  defaultOverrideModelConfig?: { modelOrAlias?: { model?: unknown; alias?: unknown } };
}

const EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/;

/** Decompose an Antigravity variant model ID (`gemini-4-argon-medium`) into `{ baseModel, effort? }`. */
export function parseAntigravityModelVariant(rawModelId: string): { baseModel: string; effort?: Effort } {
  const trimmed = rawModelId.trim();
  const match = EFFORT_SUFFIX_RE.exec(trimmed);
  if (match && match[1] && isModelId(match[1]) && (EFFORTS as readonly unknown[]).includes(match[2])) {
    return { baseModel: match[1], effort: match[2] as Effort };
  }
  return { baseModel: trimmed };
}

function addUniqueEffort(list: Effort[], effort: Effort) {
  if (!list.includes(effort)) list.push(effort);
}

/** Build a structured base-model + per-model effort catalog from `GetCascadeModelConfigData`. */
export function buildAntigravityModelCatalog(
  payload: AntigravityModelConfigPayload | undefined,
  reportedModel?: string,
  selected?: { model?: string; effort?: Effort },
): AntigravityModelCatalog {
  const variants: AntigravityModelVariant[] = [];
  const models: string[] = [];
  const byBaseEffort = new Map<string, Effort[]>();
  const enumToVariant = new Map<string, AntigravityModelVariant>();
  const seenVariantIds = new Set<string>();

  for (const item of payload?.clientModelConfigs ?? []) {
    if (!item || typeof item !== 'object' || item.disabled === true) continue;
    const hasQuota = item.quotaInfo === undefined
      ? true
      : Boolean(item.quotaInfo && typeof item.quotaInfo === 'object' && (
        typeof item.quotaInfo.remainingFraction === 'number'
          ? item.quotaInfo.remainingFraction > 0
          : Object.keys(item.quotaInfo).length > 0
      ));
    if (!hasQuota) continue;
    const rawId = typeof item.modelId === 'string' ? item.modelId.trim() : '';
    if (!isModelId(rawId) || seenVariantIds.has(rawId)) continue;
    seenVariantIds.add(rawId);

    const parsed = parseAntigravityModelVariant(rawId);
    const planModel = typeof item.modelOrAlias?.model === 'string' && item.modelOrAlias.model.trim()
      ? item.modelOrAlias.model.trim()
      : typeof item.modelOrAlias?.alias === 'string' && item.modelOrAlias.alias.trim()
        ? item.modelOrAlias.alias.trim()
        : undefined;
    const variant: AntigravityModelVariant = {
      modelId: rawId,
      baseModel: parsed.baseModel,
      ...(parsed.effort ? { effort: parsed.effort } : {}),
      ...(planModel ? { planModel } : {}),
    };
    variants.push(variant);
    if (!models.includes(variant.baseModel)) models.push(variant.baseModel);
    if (variant.effort) {
      const existing = byBaseEffort.get(variant.baseModel) ?? [];
      addUniqueEffort(existing, variant.effort);
      byBaseEffort.set(variant.baseModel, existing);
    }
    if (planModel && !enumToVariant.has(planModel)) enumToVariant.set(planModel, variant);
  }

  const modelEfforts: Partial<Record<string, Effort[]>> = {};
  for (const baseModel of models) {
    const rawEfforts = byBaseEffort.get(baseModel) ?? [];
    const ordered = EFFORTS.filter(effort => rawEfforts.includes(effort));
    if (ordered.length > 0) modelEfforts[baseModel] = [...ordered];
  }

  const parsedReported = reportedModel && isModelId(reportedModel)
    ? (enumToVariant.get(reportedModel.trim())
      ?? (() => {
        const p = parseAntigravityModelVariant(reportedModel);
        return { baseModel: p.baseModel, effort: p.effort };
      })())
    : undefined;
  const overrideEnum = typeof payload?.defaultOverrideModelConfig?.modelOrAlias?.model === 'string'
    ? payload.defaultOverrideModelConfig.modelOrAlias.model.trim()
    : typeof payload?.defaultOverrideModelConfig?.modelOrAlias?.alias === 'string'
      ? payload.defaultOverrideModelConfig.modelOrAlias.alias.trim()
      : undefined;
  const overrideVariant = overrideEnum ? enumToVariant.get(overrideEnum) : undefined;

  const preferredBase = selected?.model ?? parsedReported?.baseModel ?? overrideVariant?.baseModel ?? models[0];
  const resolvedDefault = resolveAntigravityVariant(
    { variants, models, modelEfforts },
    preferredBase,
    selected?.effort ?? parsedReported?.effort ?? overrideVariant?.effort,
  );

  return {
    variants,
    models,
    modelEfforts,
    ...(resolvedDefault ? { defaultModel: resolvedDefault.baseModel, ...(resolvedDefault.effort ? { defaultEffort: resolvedDefault.effort } : {}) } : {}),
  };
}

/** Resolve `(requestedModel, requestedEffort?)` to one concrete available Antigravity variant. */
export function resolveAntigravityVariant(
  catalog: Pick<AntigravityModelCatalog, 'variants' | 'models' | 'modelEfforts'>,
  requestedModel?: string,
  requestedEffort?: Effort,
): AntigravityModelVariant | undefined {
  if (!catalog.variants.length) return undefined;
  const baseModel = requestedModel && catalog.models.includes(requestedModel) ? requestedModel : catalog.models[0];
  if (!baseModel) return undefined;
  const supported = catalog.modelEfforts[baseModel] ?? [];
  if (!supported.length) {
    return catalog.variants.find(variant => variant.baseModel === baseModel);
  }
  const chosenEffort = requestedEffort && supported.includes(requestedEffort)
    ? requestedEffort
    : supported.includes('medium')
      ? 'medium'
      : supported[0]!;
  return catalog.variants.find(variant => variant.baseModel === baseModel && variant.effort === chosenEffort)
    ?? catalog.variants.find(variant => variant.baseModel === baseModel);
}
