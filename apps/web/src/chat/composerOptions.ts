import { contextPercent, contextTone, type Effort } from '@extalia/core';
import { PERMISSION_MODES, type PermissionMode, type SessionOptions } from '@extalia/platform';
import type { SelectOption } from '../ui/Select';

/**
 * The composer's per-session choices (v0.0.49): permission mode beside the model and effort,
 * and the context ring. Pure: labels come in from the caller's messages.
 */

export type { PermissionMode };

/** What the composer shows and sends: the session's model, effort and permission mode. */
export type SessionChoice = SessionOptions;

/** Select value that stands for "use the default" (Radix Select cannot take an empty value). */
export const DEFAULT_CHOICE = '__default__';
/** Select value of the disabled Hermes entry. */
export const HERMES_CHOICE = 'managed-by-hermes';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The stored choice as the session's options carry it; unknown permission values fall back to the workspace default. */
export function choiceFromOptions(options: SessionOptions | undefined): SessionChoice {
  return cleanChoice({
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.effort ? { effort: options.effort } : {}),
    ...(isPermissionMode(options?.permissionMode) ? { permissionMode: options.permissionMode } : {}),
  });
}

/** The choice to store or send: empty fields and the workspace default are left out, so the host falls back to its defaults. */
export function cleanChoice(choice: SessionChoice): SessionChoice {
  const clean: SessionChoice = {};
  if (choice.model) clean.model = choice.model;
  if (choice.effort) clean.effort = choice.effort;
  if (choice.permissionMode && choice.permissionMode !== 'workspace') clean.permissionMode = choice.permissionMode;
  return clean;
}

/** Select value for an optional choice. */
export function choiceValue(value: string | undefined): string {
  return value ?? DEFAULT_CHOICE;
}

/** Back from a Select value to a choice; the default entry clears it. */
export function choiceFromValue(value: string): string | undefined {
  return value === DEFAULT_CHOICE || value === '' ? undefined : value;
}

export interface ModelOptionLabels {
  /** `Default (x)` or, without a known default model, `Default`. */
  defaultLabel(model: string | undefined): string;
}

/**
 * Model entries: the default first, then the workspace's models. A model the session already uses
 * is listed even when the runtime does not list it, so the picker never hides the current choice.
 */
export function modelSelectOptions(input: { defaultModel?: string | undefined; models: readonly string[]; current?: string | undefined }, labels: ModelOptionLabels): SelectOption[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const model of [input.defaultModel, ...input.models, input.current]) {
    const id = model?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return [
    { value: DEFAULT_CHOICE, label: labels.defaultLabel(input.defaultModel) },
    ...models.filter(model => model !== input.defaultModel).map(model => ({ value: model, label: model })),
  ];
}

export interface EffortOptionLabels {
  effort(value: Effort): string;
  /** `Default (High)` or `Default`. */
  defaultLabel(effort: string | undefined): string;
}

/** Effort entries; none when the runtime does not change the reasoning effort (the picker is then hidden). */
export function effortSelectOptions(input: { efforts: readonly Effort[]; defaultEffort?: Effort | undefined }, labels: EffortOptionLabels): SelectOption[] {
  if (input.efforts.length === 0) return [];
  return [
    { value: DEFAULT_CHOICE, label: labels.defaultLabel(input.defaultEffort ? labels.effort(input.defaultEffort) : undefined) },
    ...input.efforts.map(effort => ({ value: effort, label: labels.effort(effort) })),
  ];
}

export interface PermissionOptionLabels {
  label(mode: PermissionMode): string;
  description(mode: PermissionMode): string;
  managed: { label: string; description: string };
}

const PERMISSION_ICON: Record<PermissionMode, 'folder' | 'shield' | 'edit' | 'eye'> = {
  workspace: 'folder', ask: 'shield', 'accept-edits': 'edit', plan: 'eye',
};

/**
 * Permission entries; a Hermes session gets one disabled entry because Hermes manages its own approvals.
 * `modes` are the ones the runtime offers (absent: all four); the session's current mode stays listed.
 */
export function permissionSelectOptions(runtime: 'hermes' | 'extalia-native', labels: PermissionOptionLabels, input: { modes?: readonly PermissionMode[] | undefined; current?: PermissionMode | undefined } = {}): SelectOption[] {
  if (runtime === 'hermes') return [{ value: HERMES_CHOICE, label: labels.managed.label, description: labels.managed.description, icon: 'bulb', disabled: true }];
  const offered = input.modes ?? PERMISSION_MODES;
  const modes = PERMISSION_MODES.filter(mode => offered.includes(mode) || mode === input.current);
  return modes.map(mode => ({ value: mode, label: labels.label(mode), description: labels.description(mode), icon: PERMISSION_ICON[mode] }));
}

export type ContextToneName = 'normal' | 'warning' | 'danger';

export interface ContextRingShape {
  /** Share of the window in use, capped at 100 for drawing. */
  percent: number;
  tone: ContextToneName;
  /** Stroke length of the arc for a circle of radius `radius`. */
  dash: number;
  /** Full circumference, the dash array's total. */
  circumference: number;
}

export const CONTEXT_RING_RADIUS = 9;

/**
 * The ring for a context reading: absent when the window is unknown (no percentage to show).
 * Warning from 80%, danger from 95% (the shared thresholds).
 */
export function contextRing(context: { usedTokens: number; windowTokens?: number | undefined } | undefined): ContextRingShape | undefined {
  if (!context) return undefined;
  const raw = contextPercent(context.usedTokens, context.windowTokens);
  if (raw === undefined) return undefined;
  const percent = Math.max(0, Math.min(100, raw));
  const circumference = 2 * Math.PI * CONTEXT_RING_RADIUS;
  return { percent, tone: contextTone(raw), dash: (percent / 100) * circumference, circumference };
}
