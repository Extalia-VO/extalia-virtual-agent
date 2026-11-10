import type * as ReactDOM from 'react-dom';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillBookPreview } from '../src/skills/SkillBookPreview';
import type { SkillBook } from '../src/skills/skillLibraryModel';

vi.mock('react-dom', async original => ({ ...await original<typeof ReactDOM>(), createPortal: (children: ReactNode) => children }));
afterEach(() => vi.unstubAllGlobals());

describe('Grimoire preview presence', () => {
  it('retains exiting text for its fade while removing it from the accessibility tree', () => {
    vi.stubGlobal('document', { body: {} });
    const book: SkillBook = { id: 'builtin:review', title: '<literal review>', description: '', category: 'quality', source: 'builtin', status: 'bundled' };
    const render = (exiting: boolean) => renderToStaticMarkup(createElement(SkillBookPreview, {
      id: 'preview', book, category: 'Quality', preview: { id: book.id, clientX: 80, clientY: 90, origin: 'focus', exiting },
    }));
    expect(render(false)).toContain('role="tooltip"');
    expect(render(false)).not.toContain('role="tooltip" aria-hidden="true"');
    const exiting = render(true);
    expect(exiting).toContain('data-exiting="true"');
    expect(exiting).toContain('aria-hidden="true"');
    expect(exiting).toContain('&lt;literal review&gt;');
    expect(exiting).toContain('Quality');
    expect(exiting).not.toContain('<literal review>');
  });
});
