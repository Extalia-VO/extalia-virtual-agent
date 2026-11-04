import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { OfficeLoading } from '../src/office/OfficeLoading';

const html = (stage: 'engine' | 'scene' | 'ready', reducedMotion: boolean) => renderToStaticMarkup(createElement(OfficeLoading, { t: MESSAGES.en, stage, reducedMotion }));
describe('OfficeLoading', () => {
  it('renders the percent text and progressbar', () => {
    const out = html('engine', false);
    expect(out).toContain('3%');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('shimmer');
  });
  it('has no shimmer class under reduced motion', () => {
    expect(html('scene', true)).not.toContain('shimmer');
    expect(html('ready', false)).toContain('100%');
  });
});
