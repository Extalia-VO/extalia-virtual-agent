import { Children, createElement, isValidElement, lazy, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { PageLoadBoundary, PageLoadError } from '../src/pages/PageLoadBoundary';

const ready = () => createElement('article', null, 'Page ready');
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('page-only deferred loading', () => {
  it('shows a localized status while a page loads and reuses its loaded component', async () => {
    let complete!: (value: { default: typeof ready }) => void;
    const load = vi.fn(() => new Promise<{ default: typeof ready }>(resolve => { complete = resolve; }));
    const DeferredPage = lazy(load);
    const render = () => renderToString(createElement(PageLoadBoundary, { t: MESSAGES.id, children: createElement(DeferredPage) }));
    const pending = render();
    expect(pending).toContain('role="status"');
    expect(pending).toContain(MESSAGES.id.pageLoading.loading);
    expect(pending).not.toContain('<article>Page ready</article>');
    expect(load).toHaveBeenCalledOnce();
    complete({ default: ready }); await settle();
    expect(render()).toContain('<article>Page ready</article>');
    expect(render()).not.toContain(MESSAGES.id.pageLoading.loading);
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not reload from rendering the recovery state and exposes only the explicit reload action', () => {
    const reload = vi.fn();
    const view = PageLoadError({ t: MESSAGES.id, onReload: reload });
    const html = renderToStaticMarkup(view);
    expect(html).toContain(MESSAGES.id.pageLoading.failed);
    expect(html).toContain(MESSAGES.id.pageLoading.recovery);
    expect(reload).not.toHaveBeenCalled();
    const button = Children.toArray(view.props.children as ReactNode).find(child => isValidElement(child) && child.type === 'button');
    expect(button).toBeDefined();
    (button as ReactElement<{ onClick(): void }>).props.onClick();
    expect(reload).toHaveBeenCalledOnce();
  });
});
