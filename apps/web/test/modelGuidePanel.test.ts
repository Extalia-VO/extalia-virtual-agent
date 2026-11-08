import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentHostApi, ModelSelectionGuide } from '@extalia/platform';
import { ModelGuidePanel } from '../src/planning/ModelGuidePanel';
import { PlanningBasisNote } from '../src/planning/PlanningBasisNote';
import { MESSAGES } from '../src/i18n';
// Exercise the actual shared composer handlers with scoped in-memory hooks.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], memo: new Map<number, { deps: unknown[]; value: unknown }>(), effects: new Map<number, unknown[]>(), pending: [] as (() => void)[] }));
vi.mock('../src/restart/unsavedDrafts', () => ({ useUnsavedDraft: () => undefined }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const effect = (run: () => void, deps: unknown[]) => {
    const id = hooks.index++;
    if (!same(hooks.effects.get(id), deps)) { hooks.effects.set(id, deps); hooks.pending.push(run); }
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.state[id]) : next;
        if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
      }];
    },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const id = hooks.index++, prior = hooks.memo.get(id);
      if (!prior || !same(prior.deps, deps)) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect, useId: () => 'test-composer',
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const change = (node: ReactElement<Record<string, unknown>>, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });


const guide: ModelSelectionGuide = { title: 'Team reference', revision: 'r1', text: 'Use actual available IDs; choose a fast reader for bounded tasks.', updatedAt: '2026-11-08T00:00:00.000Z' };
function harness(language: 'en' | 'id' = 'en') {
  const get = vi.fn(async (): Promise<ModelSelectionGuide | null> => null);
  const save = vi.fn(async (input): Promise<ModelSelectionGuide | null> => input ? { ...input, updatedAt: guide.updatedAt } : null);
  const props: Parameters<typeof ModelGuidePanel>[0] = { agents: { getModelSelectionGuide: get, saveModelSelectionGuide: save } as unknown as AgentHostApi, t: MESSAGES[language], onPendingChange: vi.fn() };
  const render = () => { let tree: ReactNode; do { hooks.dirty = false; hooks.index = 0; tree = ModelGuidePanel(props); for (const run of hooks.pending.splice(0)) run(); } while (hooks.dirty); return tree; };
  const field = (suffix: string) => elements(render()).find(node => typeof node.props.id === 'string' && node.props.id.endsWith(suffix))!;
  const edit = (suffix: string, value: string) => change(field(suffix), value);
  const button = (label: string) => elements(render()).find(node => node.type === 'button' && text(node) === label)!;
  const click = (label: string) => (button(label).props.onClick as () => void)();
  const importFile = (read: Promise<string>, size = 10) => { const picker = elements(render()).find(node => node.type === 'input' && node.props.type === 'file')!; (picker.props.onChange as (e: unknown) => void)({ target: { files: [{ size, text: () => read }], value: 'guide.md' } }); };
  return { props, get, save, render, field, edit, button, click, importFile };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = []; });

it.each(['en', 'id'] as const)('shows knowledge fallback and saves an explicitly versioned guide in %s', async language => {
  const h = harness(language), c = MESSAGES[language].modelGuide;
  h.render(); await settle();
  expect(text(h.render())).toContain(c.none);
  h.edit('-title', guide.title); h.edit('-revision', guide.revision); h.edit('-text', guide.text);
  expect(h.button(c.save).props.disabled).toBe(false);
  expect(text(h.render())).toContain(c.unsaved);
  h.click(c.save); await settle();
  expect(h.save).toHaveBeenCalledWith({ title: guide.title, revision: guide.revision, text: guide.text });
  expect(text(h.render())).toContain(c.saved);
  expect(text(h.render())).toContain(guide.revision);
  h.click(c.clear); await settle();
  expect(h.save).toHaveBeenLastCalledWith(null);
  expect(text(h.render())).toContain(c.none);
});

it('retains over-limit text rather than truncating and disables Save', async () => {
  const h = harness(); h.render(); await settle();
  h.edit('-title', guide.title); h.edit('-revision', guide.revision);
  const long = 'x'.repeat(24001); h.edit('-text', long);
  expect(h.field('-text').props.value).toBe(long);
  expect(h.button(MESSAGES.en.modelGuide.save).props.disabled).toBe(true);
  expect(text(h.render())).toContain(MESSAGES.en.modelGuide.limit);
});

it('marks a delayed file import pending and prevents a plan from racing its read', async () => {
  const h = harness(); h.render(); await settle();
  let resolve!: (text: string) => void;
  h.importFile(new Promise<string>(done => { resolve = done; }));
  expect(h.props.onPendingChange).toHaveBeenLastCalledWith(true);
  expect(h.field('-text').props.disabled).toBe(true);
  resolve('Full guide text from file'); await settle();
  expect(h.field('-text').props.value).toBe('Full guide text from file');
  expect(h.field('-text').props.disabled).toBe(false);
  expect(h.props.onPendingChange).toHaveBeenLastCalledWith(true);
});

it('does not let an older file read overwrite a newer import', async () => {
  const h = harness(); h.render(); await settle();
  let resolve!: (text: string) => void;
  h.importFile(new Promise<string>(done => { resolve = done; }));
  h.importFile(Promise.resolve('Newer guide')); await settle();
  resolve('Older guide'); await settle();
  expect(h.field('-text').props.value).toBe('Newer guide');
});

it('keeps edits on save failure and recognizes an older remote host', async () => {
  const h = harness(); h.render(); await settle();
  h.edit('-title', guide.title); h.edit('-revision', guide.revision); h.edit('-text', guide.text);
  h.save.mockRejectedValue(new Error('Write refused'));
  h.click(MESSAGES.en.modelGuide.save); await settle();
  expect(h.field('-text').props.value).toBe(guide.text);
  expect(text(h.render())).toContain('Write refused');
});

it.each(['Method is not available on this host.', 'Unknown agent host method.'])('recognizes unsupported hosts: %s', async message => {
  const h = harness(); h.get.mockRejectedValue(new Error(message));
  h.render(); await settle();
  expect(text(h.render())).toContain(MESSAGES.en.modelGuide.unavailable);
  expect(text(h.render())).not.toContain(MESSAGES.en.modelGuide.none);
});

it('labels deterministic fallbacks separately from model knowledge and guide evidence', () => {
  expect(text(PlanningBasisNote({ basis: { kind: 'heuristic' }, t: MESSAGES.en }))).toBe(MESSAGES.en.modelGuide.basisHeuristic);
  expect(text(PlanningBasisNote({ basis: { kind: 'model-knowledge' }, t: MESSAGES.en }))).toBe(MESSAGES.en.modelGuide.basisKnowledge);
  expect(text(PlanningBasisNote({ basis: { kind: 'guide', title: guide.title, revision: guide.revision, updatedAt: guide.updatedAt }, t: MESSAGES.en }))).toContain(guide.revision);
});
