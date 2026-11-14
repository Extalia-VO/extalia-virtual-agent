import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ConnectionForm } from '../src/setup/ConnectionForm';
import { connectionTestTarget, currentConnectionTest, finishConnectionTest, type ConnectionTestState } from '../src/setup/connectionTestFlow';
import { TEST_MODEL_PLACEHOLDER, draftFromPreset, toConnectionTestInput } from '../src/setup/validation';

describe('test-first connection setup', () => {
  it.each(['en', 'id'] as const)('links connection validation errors to the affected controls (%s)', language => {
    const t = MESSAGES[language];
    const draft = draftFromPreset('openai');
    const render = (showAllErrors: boolean) => renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft: { ...draft, name: '', orchestration: { ...draft.orchestration, maxDelegations: '21' } },
      agents: {} as never, onChange: () => undefined, showAllErrors,
    }));
    expect(render(false).match(/<input[^>]+id="[^"]+-name"[^>]*>/)?.[0]).not.toContain('aria-describedby');
    const html = render(true);
    for (const field of ['name', 'model', 'maxDelegations']) {
      const control = html.match(new RegExp(`<(?:input|button)[^>]+id="[^"]+-${field}"[^>]*>`))?.[0];
      expect(control).toContain('aria-invalid="true"');
      expect(control).toMatch(new RegExp(`aria-describedby="[^"]*-${field}-error`));
    }
  });

  it('keeps credentials and endpoint identifiers out of browser text correction', () => {
    const t = MESSAGES.en;
    const render = (credentialMode: 'key' | 'env') => renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft: { ...draftFromPreset('openai'), credentialMode }, agents: {} as never, onChange: () => undefined,
    }));
    const keyHtml = render('key');
    const key = keyHtml.match(/<input[^>]+id="[^"]+-apiKey"[^>]*>/)?.[0];
    expect(key).toContain('type="password"');
    expect(key).toContain('autoComplete="new-password"');
    const endpoint = keyHtml.match(/<input[^>]+id="[^"]+-baseUrl"[^>]*>/)?.[0];
    const env = render('env').match(/<input[^>]+id="[^"]+-envVariable"[^>]*>/)?.[0];
    for (const control of [key, endpoint, env]) {
      expect(control).toContain('autoCapitalize="off"');
      expect(control).toContain('autoCorrect="off"');
      expect(control).toContain('spellCheck="false"');
    }
    expect(env).toContain('maxLength="128"');
  });

  it.each(['en', 'id'] as const)('offers an accessible, default-off cache switch only for the official Anthropic endpoint (%s)', language => {
    const t = MESSAGES[language];
    const render = (draft: ReturnType<typeof draftFromPreset>) => renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft, agents: {} as never, onChange: () => undefined,
    }));
    const draft = draftFromPreset('anthropic');
    const html = render(draft);
    expect(html).toContain(t.connection.promptCache);
    expect(html).toContain(t.connection.promptCacheHint);
    const cacheSwitch = html.match(/<input[^>]*aria-describedby="[^"]*-prompt-cache-hint"[^>]*>/)?.[0];
    expect(cacheSwitch).toBeDefined();
    expect(cacheSwitch).toContain('role="switch"');
    expect(cacheSwitch).not.toContain('checked=');
    expect(render({ ...draft, promptCache: true })).toMatch(/<input[^>]*aria-describedby="[^"]*-prompt-cache-hint"[^>]*checked=""/);
    expect(render({ ...draft, baseUrl: 'https://api.example.com' })).not.toContain(t.connection.promptCache);
    expect(render(draftFromPreset('openai'))).not.toContain(t.connection.promptCache);
    expect(render(draftFromPreset('custom'))).not.toContain(t.connection.promptCache);
  });

  it.each(['en', 'id'] as const)('renders the optional estimated input ceiling and localized validation (%s)', language => {
    const t = MESSAGES[language];
    const render = (inputTokenLimit = '') => renderToStaticMarkup(createElement(ConnectionForm, {
      t, draft: { ...draftFromPreset('openai'), inputTokenLimit }, agents: {} as never, onChange: () => undefined, showAllErrors: true,
    }));
    const initial = render();
    expect(initial).toContain(t.connection.inputTokenLimit);
    expect(initial).toContain(t.connection.inputTokenLimitHint);
    expect(initial).toMatch(/<input[^>]*type="number"[^>]*min="1024"[^>]*max="2000000"[^>]*step="1"[^>]*value=""/);
    expect(render('50000')).toMatch(/<input[^>]*type="number"[^>]*value="50000"/);
    expect(render('1')).toContain(t.connection.errors.inputTokenLimitInvalid);
    expect(render('1')).toMatch(/<input[^>]*type="number"[^>]*aria-invalid="true"/);
  });

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
