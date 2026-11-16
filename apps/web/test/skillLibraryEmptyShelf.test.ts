import type * as React from 'react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillLibraryView } from '../src/skills/SkillLibrary';
import { skillBooks } from '../src/skills/skillLibraryModel';
import { Select } from '../src/ui/Select';

// Keep event-driven page state across server captures without rendering WebGL.
const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[index], (next: unknown) => { hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next; }];
  },
}));
vi.mock('../src/skills/SkillBookPreview', () => ({
  SkillBookPreview: () => null,
  useSkillBookPreview: () => ({ preview: null, id: 'preview', onHover: vi.fn(), onFocus: vi.fn(), onPointerMove: vi.fn(), onKeyDown: vi.fn(), onBlur: vi.fn(), clear: vi.fn() }),
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const books = skillBooks([{ name: 'release-plan', description: 'Plan release', category: 'planning' }, { name: 'code-review', description: 'Review code', category: 'quality' }], []);

function harness(language: 'en' | 'id' = 'en', empty = false) {
  const props: Parameters<typeof SkillLibraryView>[0] = { t: MESSAGES[language], books: empty ? [] : books };
  const render = () => {
    hooks.index = 0;
    let tree: ReactNode;
    function Capture() { tree = SkillLibraryView(props); return null; }
    renderToStaticMarkup(createElement(Capture));
    return elements(tree);
  };
  const canvas = () => render().find(node => 'onShelfRest' in node.props);
  const picker = () => render().find(node => node.type === Select && node.props['aria-label'] === props.t.skillLibrary.books);
  const filter = (value: string) => {
    const category = render().find(node => node.type === Select && node.props['aria-label'] === props.t.skillLibrary.category)!;
    (category.props.onChange as (value: string) => void)(value);
  };
  const list = () => {
    const button = render().find(node => node.type === 'button' && text(node) === props.t.skillLibrary.views.list)!;
    (button.props.onClick as () => void)();
  };
  return { props, render, canvas, picker, filter, list };
}

beforeEach(() => { hooks.index = 0; hooks.state = []; });
afterEach(() => vi.unstubAllGlobals());

describe('Grimoire fixed rack visibility', () => {
  for (const language of ['en', 'id'] as const) it(`retains an empty Book rack and localized empty/loading note in ${language}`, () => {
    const h = harness(language, true);
    expect(h.render().some(node => node.props.role === 'region')).toBe(true);
    expect(h.canvas()?.props.books).toEqual([]);
    expect(h.canvas()?.props.reader).toMatchObject({ id: null });
    expect(h.picker()).toBeUndefined();
    expect(h.render().some(node => text(node) === h.props.t.skillLibrary.empty)).toBe(true);
    expect(h.render().some(node => node.props.className === 'skill-shelf-caption')).toBe(false);
    h.props.loading = true;
    expect(h.render().some(node => text(node) === h.props.t.skillsPage.loading)).toBe(true);
    expect(h.canvas()?.props.books).toEqual([]);
  });

  it('keeps the rack through one-match, zero-match and All filters while updating only its books', () => {
    const h = harness();
    expect(h.canvas()?.props.books).toHaveLength(2);
    h.filter('planning'); expect(h.canvas()?.props.books).toEqual([books[0]]);
    h.filter('security'); expect(h.canvas()?.props.books).toEqual([]);
    expect(h.render().some(node => node.props.role === 'region')).toBe(true);
    expect(h.picker()).toBeUndefined();
    h.filter('all'); expect(h.canvas()?.props.books).toEqual(books);
    expect(h.picker()).toBeDefined();
  });

  it('shows the empty note without a rack in List view and on WebGL fallback', () => {
    const h = harness();
    h.filter('security');
    (h.canvas()!.props.onAvailability as (ready: boolean) => void)(false);
    expect(h.canvas()).toBeUndefined();
    expect(h.render().some(node => node.props.role === 'region')).toBe(false);
    expect(h.render().some(node => text(node) === h.props.t.skillLibrary.empty)).toBe(true);
    expect(h.render().some(node => text(node) === h.props.t.skillLibrary.unavailable)).toBe(true);
    h.list();
    expect(h.canvas()).toBeUndefined();
  });

  it('does not retain a reading book or its picker when the catalog becomes empty', () => {
    const h = harness();
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('HTMLElement', class {});
    (h.canvas()!.props.onSelect as (id: string) => void)(books[0]!.id);
    expect(h.canvas()?.props.reader).toMatchObject({ id: books[0]!.id });
    h.props.books = [];
    expect(h.canvas()?.props.books).toEqual([]);
    expect(h.canvas()?.props.reader).toMatchObject({ id: null });
    expect(h.picker()).toBeUndefined();
    expect(h.render().some(node => node.props.className === 'skill-book-toolbar')).toBe(false);
  });
});
