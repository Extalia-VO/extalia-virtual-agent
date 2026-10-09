import { EFFORTS, PROVIDER_PRESETS, TASK_TIERS, presetById, type Effort, type FeatureOwner } from '@extalia/core';
import type { AgentHostApi, ConnectionTestResult } from '@extalia/platform';
import { useId, useState, type ReactNode } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { draftFromPreset, suggestedTiers, toConnectionInput, validateConnection, type ConnectionDraft, type ConnectionField, type OrchestrationDraft } from './validation';

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'done'; result: ConnectionTestResult };

/** Connection editor used by the first-run wizard and Settings. The parent saves. */
export function ConnectionForm({ t, agents, draft, onChange, showAllErrors = false }: {
  t: Messages;
  agents: AgentHostApi;
  draft: ConnectionDraft;
  onChange: (draft: ConnectionDraft) => void;
  showAllErrors?: boolean;
}) {
  const id = useId();
  const preset = presetById(draft.preset);
  const [touched, setTouched] = useState<ReadonlySet<ConnectionField>>(new Set());
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const errors = validateConnection(draft);
  const errorFor = (field: ConnectionField) => (showAllErrors || touched.has(field)) && errors[field] ? t.connection.errors[errors[field]] : undefined;
  const touch = (field: ConnectionField) => () => setTouched(previous => new Set(previous).add(field));
  const update = (patch: Partial<ConnectionDraft>) => onChange({ ...draft, ...patch });
  const orchestration = draft.orchestration;
  const updateOrchestration = (patch: Partial<OrchestrationDraft>) => update({ orchestration: { ...orchestration, ...patch } });
  const suggested = suggestedTiers(draft.preset);
  const usesSuggested = suggested && TASK_TIERS.every(tier => orchestration.tiers[tier] === suggested[tier]);
  const models = test.kind === 'done' && test.result.ok ? test.result.models ?? [] : [];
  const canTest = !errors.baseUrl && !errors.apiKey && !errors.envVariable && test.kind !== 'testing';

  async function runTest() {
    setTest({ kind: 'testing' });
    const { input, secret } = toConnectionInput(draft);
    try { setTest({ kind: 'done', result: await agents.testConnection(input, secret) }); }
    catch (error) { setTest({ kind: 'done', result: { ok: false, error: errorMessage(error) } }); }
  }

  const ownerOptions = (native: boolean) => [
    { value: 'extalia' as FeatureOwner, label: t.connection.owners.extalia },
    ...(native ? [{ value: 'provider' as FeatureOwner, label: preset.label }] : []),
    { value: 'off' as FeatureOwner, label: t.connection.owners.off },
  ];

  const field = (name: ConnectionField, label: string, input: ReactNode, hint?: string) => {
    const error = errorFor(name);
    return (
      <div className="field">
        <label htmlFor={`${id}-${name}`}>{label}</label>
        {input}
        {error ? <small className="field-error" id={`${id}-${name}-error`}>{error}</small> : hint ? <small className="muted" id={`${id}-${name}-hint`}>{hint}</small> : null}
      </div>
    );
  };
  const describedBy = (name: ConnectionField) => errorFor(name) ? `${id}-${name}-error` : `${id}-${name}-hint`;

  return (
    <div className="form-stack">
      <fieldset className="preset-picker">
        <legend>{t.connection.provider}</legend>
        <div className="preset-grid">
          {PROVIDER_PRESETS.map(item => (
            <label key={item.id} className="preset-card">
              <input type="radio" name={`${id}-preset`} value={item.id} checked={draft.preset === item.id}
                onChange={() => { setTest({ kind: 'idle' }); onChange(draftFromPreset(item.id, draft)); }} />
              <span className="preset-name">{item.label}{item.local && <span className="chip">{t.connection.local}</span>}</span>
              <span className="preset-hint">{t.connection.presetHints[item.id]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="form-grid">
        {field('name', t.connection.name,
          <input id={`${id}-name`} type="text" value={draft.name} maxLength={120} autoComplete="off" aria-invalid={Boolean(errorFor('name'))} aria-describedby={describedBy('name')}
            onChange={event => update({ name: event.target.value })} onBlur={touch('name')} />)}
        {field('baseUrl', t.connection.baseUrl,
          <input id={`${id}-baseUrl`} type="url" inputMode="url" value={draft.baseUrl} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1"
            aria-invalid={Boolean(errorFor('baseUrl'))} aria-describedby={describedBy('baseUrl')}
            onChange={event => update({ baseUrl: event.target.value })} onBlur={touch('baseUrl')} />,
          t.connection.baseUrlHint[preset.api])}
      </div>

      {preset.apiKey === 'none' ? (
        <p className="note"><Icon name="key" />{t.connection.noKey}</p>
      ) : (
        <div className="form-stack tight">
          <Segmented legend={t.connection.credential} value={draft.credentialMode}
            options={[{ value: 'key', label: t.connection.credentialModes.key }, { value: 'env', label: t.connection.credentialModes.env }]}
            onChange={credentialMode => update({ credentialMode })} />
          {draft.credentialMode === 'key'
            ? field('apiKey', preset.apiKey === 'required' ? t.connection.apiKey : t.connection.apiKeyOptional,
              <input id={`${id}-apiKey`} type="password" value={draft.apiKey} spellCheck={false} autoComplete="new-password"
                placeholder={draft.hasStoredKey ? '••••••••' : ''} aria-invalid={Boolean(errorFor('apiKey'))} aria-describedby={describedBy('apiKey')}
                onChange={event => update({ apiKey: event.target.value })} onBlur={touch('apiKey')} />,
              draft.hasStoredKey ? t.connection.apiKeyStored : t.connection.apiKeyHint)
            : field('envVariable', t.connection.envVariable,
              <input id={`${id}-envVariable`} type="text" value={draft.envVariable} spellCheck={false} autoComplete="off" placeholder="OPENAI_API_KEY"
                aria-invalid={Boolean(errorFor('envVariable'))} aria-describedby={describedBy('envVariable')}
                onChange={event => update({ envVariable: event.target.value.toUpperCase() })} onBlur={touch('envVariable')} />,
              t.connection.envHint)}
        </div>
      )}

      <div className="form-grid">
        {field('model', t.connection.model,
          <>
            <input id={`${id}-model`} type="text" value={draft.model} list={models.length ? `${id}-models` : undefined} spellCheck={false} autoComplete="off"
              aria-invalid={Boolean(errorFor('model'))} aria-describedby={describedBy('model')}
              onChange={event => update({ model: event.target.value })} onBlur={touch('model')} />
            {models.length > 0 && <datalist id={`${id}-models`}>{models.map(model => <option key={model} value={model} />)}</datalist>}
          </>,
          t.connection.modelHint)}
        {preset.api === 'anthropic-messages' && (
          <div className="field">
            <label htmlFor={`${id}-effort`}>{t.connection.effort}</label>
            <select id={`${id}-effort`} value={draft.effort} onChange={event => update({ effort: event.target.value as Effort })}>
              {EFFORTS.map(effort => <option key={effort} value={effort}>{t.connection.efforts[effort]}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="test-row">
        <button type="button" className="button" disabled={!canTest} onClick={runTest}>
          <Icon name={test.kind === 'testing' ? 'refresh' : 'check'} className={test.kind === 'testing' ? 'spin' : ''} />
          {test.kind === 'testing' ? t.connection.testing : t.connection.test}
        </button>
        <div className="test-result" role="status" aria-live="polite">
          {test.kind === 'done' && (test.result.ok ? (
            <>
              <span className="status ok"><Icon name="check" />{t.connection.testOk(test.result.latencyMs)}</span>
              {models.length > 0 && (
                <div className="model-chips">
                  <span className="muted">{t.connection.testModels(models.length)}</span>
                  {models.slice(0, 12).map(model => (
                    <button key={model} type="button" className="chip-button" aria-pressed={draft.model === model} aria-label={t.connection.useModel(model)} onClick={() => update({ model })}>{model}</button>
                  ))}
                </div>
              )}
            </>
          ) : <span className="status error"><Icon name="alert" />{t.connection.testFailed} {test.result.error}</span>)}
        </div>
      </div>

      <div className="form-stack tight">
        <h3 className="form-heading">{t.connection.features}</h3>
        <div className="form-grid">
          <Segmented legend={t.connection.memory} value={draft.memory} options={ownerOptions(preset.nativeMemory)} onChange={memory => update({ memory })} />
          <Segmented legend={t.connection.skills} value={draft.skills} options={ownerOptions(preset.nativeSkills)} onChange={skills => update({ skills })} />
        </div>
        <p className="muted small">{preset.nativeMemory || preset.nativeSkills ? t.connection.featuresHintNative(preset.label) : t.connection.featuresHint}</p>
      </div>

      <div className="form-stack tight">
        <h3 className="form-heading">{t.connection.orchestration}</h3>
        <label className="switch">
          <input type="checkbox" role="switch" checked={orchestration.enabled} aria-describedby={`${id}-orchestration-hint`}
            onChange={event => updateOrchestration({ enabled: event.target.checked })} />
          <span className="switch-track" aria-hidden="true" />
          <span>{t.connection.orchestrationToggle}</span>
        </label>
        <p className="muted small" id={`${id}-orchestration-hint`}>{t.connection.orchestrationHint}</p>
        {orchestration.enabled && (
          <>
            <div className="form-grid tiers">
              {field('maxDelegations', t.connection.maxDelegations,
                <input id={`${id}-maxDelegations`} type="number" inputMode="numeric" min={0} max={20} step={1} value={orchestration.maxDelegations}
                  aria-invalid={Boolean(errorFor('maxDelegations'))} aria-describedby={describedBy('maxDelegations')}
                  onChange={event => updateOrchestration({ maxDelegations: event.target.value })} onBlur={touch('maxDelegations')} />)}
              {TASK_TIERS.map(tier => (
                <div className="field" key={tier}>
                  <label htmlFor={`${id}-tier-${tier}`}>{t.connection.tierModel(t.connection.tiers[tier])}</label>
                  <input id={`${id}-tier-${tier}`} type="text" value={orchestration.tiers[tier]} list={models.length ? `${id}-models` : undefined} spellCheck={false} autoComplete="off"
                    placeholder={t.connection.tierPlaceholder(draft.model.trim())}
                    onChange={event => updateOrchestration({ tiers: { ...orchestration.tiers, [tier]: event.target.value } })} />
                </div>
              ))}
            </div>
            {suggested && !usesSuggested && (
              <div><button type="button" className="button small" onClick={() => updateOrchestration({ tiers: { ...suggested } })}><Icon name="spark" />{t.connection.useSuggested}</button></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
