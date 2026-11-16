import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkillLoadCard } from '../src/chat/SkillLoadCard';
import { TranscriptView } from '../src/chat/TranscriptView';
import type { SkillLoadItem } from '../src/chat/transcript';
import { MESSAGES, type Language } from '../src/i18n';

const item = (): SkillLoadItem => ({ kind: 'skills', id: 'receipt', owner: 'primary', characters: 1234, budgetCharacters: 24_000, skills: [
  { name: 'memory-recall', source: 'builtin', reason: 'default-memory', status: 'loaded', characters: 900 },
  { name: 'orchestrator', source: 'builtin', reason: 'configured-team', status: 'not-configured', characters: 0 },
  { name: 'code-review', source: 'builtin', reason: 'current-context', status: 'budget', characters: 0, intent: 'review' },
  { name: 'registered-review', source: 'registry', reason: 'recent-context', status: 'unavailable', characters: 0 },
] });
const render = (value: SkillLoadItem, language: Language = 'en') => renderToStaticMarkup(createElement(SkillLoadCard, { t: MESSAGES[language], item: value, language }));

describe('automatic skill context disclosure', () => {
  for (const language of ['en', 'id'] as const) it(`shows actual load and skip reasons in ${language} without claiming execution`, () => {
    const p = MESSAGES[language].chat.skillLoading;
    const html = render(item(), language);
    expect(html).toContain('<details class="skill-load-card">');
    expect(html).not.toContain('<details open');
    expect(html).toContain('<summary>');
    expect(html).toContain(p.title);
    expect(html).toContain(p.loaded(1));
    expect(html).toContain(p.skipped(3));
    expect(html).toContain(p.help);
    expect(html).toContain(p.reasons['default-memory']);
    expect(html).toContain(p.statuses['not-configured']);
    expect(html).toContain(p.statuses.budget);
    expect(html).toContain(p.statuses.unavailable);
    expect(html).toContain(p.intents.review);
    expect(html).toContain(p.sources.registry);
    const format = new Intl.NumberFormat(language);
    expect(html).toContain(p.characters(format.format(1234), format.format(24_000)));
    expect(html).not.toContain('tool-row');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('token');
  });

  it('shows a truthful empty preparation and keeps worker ownership visible', () => {
    const value = item(); value.skills = value.skills.filter(skill => skill.status !== 'loaded'); value.characters = 0;
    value.owner = 'worker'; value.agentId = 'worker'; value.agentLabel = 'Reviewer';
    const html = render(value);
    expect(html).toContain(MESSAGES.en.chat.skillLoading.loaded(0));
    expect(html).toContain(MESSAGES.en.chat.skillLoading.noneLoaded);
    expect(html).toContain('Worker: Reviewer');
    expect(html).not.toContain(MESSAGES.en.chat.skillLoading.help);
    expect(html).not.toContain('Primary agent');
  });

  it('renders names as literal text, including long unbroken labels and unknown-agent ownership', () => {
    const value = item(); value.owner = 'agent'; value.agentId = '<unknown>';
    value.skills[0]!.name = '<img src=x onerror=alert(1)>';
    value.skills[1]!.name = 'a'.repeat(64);
    const html = render(value);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('Agent: &lt;unknown&gt;');
    expect(html).not.toContain('<img');
  });

  it('renders through the shared Chat and Office transcript without joining tool runs', () => {
    const html = renderToStaticMarkup(createElement(TranscriptView, { t: MESSAGES.en, language: 'en',
      items: [{ kind: 'user', id: 'prompt', text: 'Review', at: '2026-11-11T00:00:00.000Z' }, item(),
        { kind: 'assistant', id: 'answer', text: 'Findings', streaming: false }], onDecide: async () => undefined }));
    expect(html.indexOf('Review')).toBeLessThan(html.indexOf('skill-load-card'));
    expect(html.indexOf('skill-load-card')).toBeLessThan(html.indexOf('Findings'));
    expect(html).not.toContain('tool-run');
  });

  for (const language of ['en', 'id'] as const) it(`reports omitted candidates separately without inventing their reasons in ${language}`, () => {
    const value = { ...item(), omitted: 1234 };
    const html = render(value, language);
    const p = MESSAGES[language].chat.skillLoading;
    expect(html).toContain(p.omitted(new Intl.NumberFormat(language).format(1234)));
    expect(html.match(/class="skill-load-entry /g)).toHaveLength(value.skills.length);
    expect(html).not.toContain(p.loaded(1235));
    expect(render({ ...value, omitted: 0 }, language)).not.toContain(p.omitted('0'));
  });
});
