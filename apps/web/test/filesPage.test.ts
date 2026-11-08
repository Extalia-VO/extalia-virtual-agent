import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, FileEntry, FileListing, HostState } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { FileBrowserEntry, FileDetails, FilesPage } from '../src/pages/FilesPage';
import { WorkspaceBar } from '../src/inspect/WorkspaceBar';

// Exercise page event handlers and actual asynchronous listing effects without a DOM.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const id = hooks.index++;
    if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[id], (next: unknown) => {
      const value = typeof next === 'function' ? next(hooks.state[id]) : next;
      if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
    }];
  },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (prior?.deps.length === deps.length && prior.deps.every((item, i) => Object.is(item, deps[i]))) return;
    prior?.cleanup?.();
    hooks.effects.set(id, { deps });
    hooks.pending.push(() => { const cleanup = run(); if (cleanup) hooks.effects.get(id)!.cleanup = cleanup; });
  },
}));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (node.type === FileBrowserEntry) return [node, ...elements(FileBrowserEntry(node.props as unknown as Parameters<typeof FileBrowserEntry>[0]))];
  if (node.type === FileDetails) return [node, ...elements(FileDetails(node.props as unknown as Parameters<typeof FileDetails>[0]))];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<Record<string, unknown>>(node) ? node.type === FileBrowserEntry ? text(FileBrowserEntry(node.props as unknown as Parameters<typeof FileBrowserEntry>[0])) : node.type === FileDetails ? text(FileDetails(node.props as unknown as Parameters<typeof FileDetails>[0])) : text(node.props.children as ReactNode) : '';
const rootEntries: FileEntry[] = [
  { name: 'src', path: 'src', kind: 'dir' },
  { name: 'README.md', path: 'README.md', kind: 'file', size: 1536 },
  { name: '.env', path: '.env', kind: 'file', credential: true, size: 10 },
  { name: 'outside', path: 'outside', kind: 'symlink' },
  { name: 'source-link', path: 'source-link', kind: 'symlink', target: 'dir' },
  { name: 'private', path: 'private', kind: 'dir', credential: true },
];
function harness(language: 'en' | 'id' = 'en') {
  const listFiles = vi.fn(async (_workspace: string, dir = '.'): Promise<FileListing> => ({ path: dir, entries: dir === '.' ? structuredClone(rootEntries) : [{ name: 'index.ts', path: `${dir}/index.ts`, kind: 'file', size: 0 }], truncated: false }));
  const readFile = vi.fn(async () => { throw new Error('File contents must never be requested'); });
  const props: Parameters<typeof FilesPage>[0] = {
    t: MESSAGES[language], language, agents: { listFiles, readFile } as unknown as AgentHostApi,
    state: { workspaces: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] } as HostState,
  };
  const render = () => { let tree: ReactNode; do { hooks.dirty = false; hooks.index = 0; tree = FilesPage(props); for (const run of hooks.pending.splice(0)) run(); } while (hooks.dirty); return tree; };
  const button = (name: string) => {
    const found = elements(render()).find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node).includes(name)));
    if (!found) throw new Error(`No button: ${name}`);
    return found;
  };
  const click = (name: string) => (button(name).props.onClick as () => void)();
  const doubleClick = (name: string) => (button(name).props.onDoubleClick as (() => void) | undefined)?.();
  const bar = () => elements(render()).find(node => node.type === WorkspaceBar)!.props as unknown as Parameters<typeof WorkspaceBar>[0];
  return { props, listFiles, readFile, render, button, click, doubleClick, bar };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.effects.clear(); hooks.pending = []; });

describe('metadata-only folder browser', () => {
  it.each(['en', 'id'] as const)('selects files and folders without reading content in %s', async language => {
    const h = harness(language); h.render(); await settle();
    h.click('README.md');
    expect(elements(h.render()).find(node => node.type === FileDetails)?.props.entry).toMatchObject({ path: 'README.md', size: 1536 });
    expect(renderToStaticMarkup(h.render())).toContain(h.props.t.files.metadataOnly);
    expect(renderToStaticMarkup(h.render())).not.toContain('code-view');
    h.doubleClick('README.md');
    h.click('.env'); h.doubleClick('.env');
    h.click('src');
    expect(elements(h.render()).find(node => node.type === FileDetails)?.props.entry).toMatchObject({ path: 'src', kind: 'dir' });
    expect(h.listFiles).toHaveBeenCalledTimes(1);
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('opens folders on double-click and clears selection on parent navigation', async () => {
    const h = harness(); h.render(); await settle();
    h.click('src'); expect(h.listFiles).toHaveBeenCalledTimes(1);
    h.doubleClick('src'); h.render(); await settle();
    expect(h.listFiles).toHaveBeenLastCalledWith('alpha', 'src');
    expect(text(h.render())).toContain('index.ts');
    expect(elements(h.render()).some(node => node.type === FileDetails)).toBe(false);
    h.click(h.props.t.files.up); h.render(); await settle();
    expect(h.listFiles).toHaveBeenLastCalledWith('alpha', '.');
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('keeps unavailable links and credential folders inspectable without navigating them', async () => {
    const h = harness(); h.render(); await settle();
    for (const name of ['outside', 'private']) {
      expect(h.button(name).props.disabled).not.toBe(true);
      h.click(name); h.doubleClick(name); h.render();
    }
    expect(h.listFiles).toHaveBeenCalledTimes(1);
    h.doubleClick('source-link'); h.render(); await settle();
    expect(h.listFiles).toHaveBeenLastCalledWith('alpha', 'source-link');
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('clears selection and returns to the root on workspace changes', async () => {
    const h = harness(); h.render(); await settle();
    h.doubleClick('src'); h.render(); await settle();
    h.click('index.ts');
    h.bar().onWorkspace('beta'); h.render(); await settle();
    expect(h.listFiles).toHaveBeenLastCalledWith('beta', '.');
    expect(elements(h.render()).some(node => node.type === FileDetails)).toBe(false);
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('drops a vanished selection when metadata refresh completes', async () => {
    const h = harness(); h.render(); await settle(); h.click('README.md');
    h.listFiles.mockResolvedValue({ path: '.', entries: [], truncated: false });
    h.bar().onRefresh(); h.render(); await settle();
    expect(text(h.render())).not.toContain('README.md');
    h.listFiles.mockResolvedValue({ path: '.', entries: rootEntries, truncated: false });
    h.bar().onRefresh(); h.render(); await settle();
    expect(elements(h.render()).some(node => node.type === FileDetails)).toBe(false);
    expect(h.readFile).not.toHaveBeenCalled();
  });
});

it('opens a selected folder with Enter or the details action, while file Enter stays metadata-only', async () => {
  const h = harness(); h.render(); await settle();
  h.click('src'); h.click(h.props.t.files.openFolder); h.render(); await settle();
  expect(h.listFiles).toHaveBeenLastCalledWith('alpha', 'src');
  h.click(h.props.t.files.up); h.render(); await settle();
  const preventDefault = vi.fn();
  (h.button('src').props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault });
  h.render(); await settle();
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(h.listFiles).toHaveBeenLastCalledWith('alpha', 'src');
  (h.button('index.ts').props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault });
  expect(h.readFile).not.toHaveBeenCalled();
});

it('updates selected size and protection flags from a fresh listing', async () => {
  const h = harness(); h.render(); await settle(); h.click('README.md');
  h.listFiles.mockResolvedValue({ path: '.', entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 0, credential: true }], truncated: false });
  h.bar().onRefresh(); h.render(); await settle();
  expect(elements(h.render()).find(node => node.type === FileDetails)?.props.entry).toMatchObject({ size: 0, credential: true });
  expect(h.readFile).not.toHaveBeenCalled();
});

it('isolates late listing responses after the host changes with the same workspace ID', async () => {
  const h = harness();
  let resolve!: (listing: FileListing) => void;
  h.listFiles.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.render();
  const listFiles = vi.fn(async (): Promise<FileListing> => ({ path: '.', entries: [{ name: 'new-host.txt', path: 'new-host.txt', kind: 'file', size: 2 }], truncated: false }));
  h.props.agents = { listFiles, readFile: h.readFile } as unknown as AgentHostApi;
  h.render(); await settle();
  expect(text(h.render())).toContain('new-host.txt');
  resolve({ path: '.', entries: rootEntries, truncated: false }); await settle();
  expect(text(h.render())).not.toContain('README.md');
  expect(text(h.render())).toContain('new-host.txt');
  expect(h.readFile).not.toHaveBeenCalled();
});
