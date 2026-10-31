import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ConnectionForm } from '../src/setup/ConnectionForm';
import { connectionTestTarget, currentConnectionTest, finishConnectionTest, type ConnectionTestState } from '../src/setup/connectionTestFlow';
import { TEST_MODEL_PLACEHOLDER, draftFromPreset, toConnectionTestInput } from '../src/setup/validation';

describe('test-first connection setup', () => {
  it('can discover models before a main model is selected', () => {
    const draft = { ...draftFromPreset('9router'), model: '' };
    expect(toConnectionTestInput(draft).input.model).toBe(TEST_MODEL_PLACEHOLDER);
    const html = renderToStaticMarkup(createElement(ConnectionForm, {
      t: MESSAGES.en, draft, agents: {} as never, onChange: () => undefined,
    }));
    const button = html.match(/<button[^>]*>[\s\S]*?Test connection<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=');
  });

  it('invalidates discovered models for endpoint and credential edits, but retains them for model selection', () => {
    const draft = draftFromPreset('9router');
    const initial = connectionTestTarget(draft);
    for (const patch of [
      { baseUrl: 'http://localhost:9999/v1' },
      { preset: 'openai' as const },
      { apiKey: 'example-key' },
      { credentialMode: 'env' as const, envVariable: 'TEST_API_KEY' },
      { hasStoredKey: true },
      { id: 'saved-connection' },
    ]) expect(connectionTestTarget({ ...draft, ...patch })).not.toBe(initial);
    expect(connectionTestTarget({ ...draft, model: 'another-model', name: 'Another name', memory: 'off', history: false })).toBe(initial);
    const env = { ...draft, credentialMode: 'env' as const, envVariable: 'TEST_API_KEY' };
    expect(connectionTestTarget({ ...env, envVariable: 'OTHER_API_KEY' })).not.toBe(connectionTestTarget(env));
  });

  it('ignores stale success and failure replies after a new endpoint or newer test starts', () => {
    const first = { target: 'first' };
    const second = { target: 'second' };
    const testing: ConnectionTestState = { kind: 'testing', scope: second, request: 2 };
    expect(finishConnectionTest(testing, { scope: first, request: 1 }, { ok: true, models: ['stale'] })).toBe(testing);
    expect(finishConnectionTest(testing, { scope: second, request: 1 }, { ok: false, error: 'Old failure' })).toBe(testing);
    expect(finishConnectionTest(testing, { scope: second, request: 2 }, { ok: true, models: ['current'] }))
      .toMatchObject({ kind: 'done', result: { ok: true, models: ['current'] } });
  });

  it('requires a fresh success after changing endpoint and changing back', () => {
    const original = { target: 'same-target' };
    const returning = { target: 'same-target' };
    const done: ConnectionTestState = { kind: 'done', scope: original, request: 1, result: { ok: true, models: ['previous'] } };
    expect(currentConnectionTest(done, original)).toBe(done);
    expect(currentConnectionTest(done, returning)).toEqual({ kind: 'idle' });
    const empty = finishConnectionTest({ kind: 'testing', scope: returning, request: 2 }, { scope: returning, request: 2 }, { ok: true, models: [] });
    expect(currentConnectionTest(empty, returning)).toMatchObject({ kind: 'done', result: { ok: true, models: [] } });
  });

  it('places testing after credentials and before the disabled model picker, including saved drafts', () => {
    const t = MESSAGES.en;
    const draft = { ...draftFromPreset('9router'), id: 'saved-connection', model: 'saved-model' };
    const html = renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft, agents: {} as never, onChange: () => undefined, knownModels: ['earlier-catalog-model'],
    }));
    expect(html.indexOf(t.connection.apiKeyOptional)).toBeLessThan(html.indexOf(t.connection.testStep));
    expect(html.indexOf(t.connection.testStep)).toBeLessThan(html.indexOf(t.connection.modelStep));
    expect(html).toMatch(/<input[^>]+id="[^"]+-model"[^>]+disabled=""[^>]+value="saved-model"/);
    expect(html).toContain(t.connection.testRequiredHint);
    expect(html).not.toContain('earlier-catalog-model');
  });

  it('offers explicit manual model entry for endpoints that cannot list models', () => {
    const t = MESSAGES.en;
    const html = renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft: draftFromPreset('custom'), agents: {} as never, onChange: () => undefined,
    }));
    expect(html).toContain(t.connection.manualModel);
    expect(html).toMatch(/<input[^>]+id="[^"]+-model"[^>]+disabled=""/);
    expect(html.indexOf(t.connection.manualModel)).toBeGreaterThan(html.indexOf(t.connection.testStep));
  });
});
