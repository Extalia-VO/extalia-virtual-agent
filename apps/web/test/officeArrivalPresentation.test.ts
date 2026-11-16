import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentPortrait, PortraitPositionContext } from '../src/office/overlay/AgentPortrait';
import type { CharacterPositionSource } from '../src/office/scene/movement/positionStore';

const loading = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/office/overlay/portrait3d', () => {
  loading.count++;
  return { Portrait3D: ({ characterId }: { characterId: string }) => createElement('span', { 'data-loaded-portrait': characterId }) };
});

describe('Office portrait admission', () => {
  it('keeps all queued portraits as SVG without requesting the 3D module, then loads only admitted identities', async () => {
    const admitted = new Set<string>();
    const source: CharacterPositionSource = {
      position: id => admitted.has(id) ? [0, 0, 0] : undefined,
      floor: id => admitted.has(id) ? 1 : undefined,
      moving: () => false,
      subscribe: () => () => {},
      version: () => admitted.size,
    };
    const ids = Array.from({ length: 32 }, (_, index) => `agent-${index}`);
    const render = () => renderToStaticMarkup(createElement(PortraitPositionContext, { value: source },
      ids.map(characterId => createElement(AgentPortrait, { key: characterId, characterId }))));
    const queued = render();
    expect((queued.match(/data-portrait-deferred="true"/g) ?? [])).toHaveLength(32);
    expect((queued.match(/<svg /g) ?? [])).toHaveLength(32);
    expect(loading.count).toBe(0);

    admitted.add(ids[0]!); admitted.add(ids[1]!);
    render();
    await vi.waitFor(() => expect(loading.count).toBe(1));
    // Let React's lazy initializer observe the resolved module before rendering again.
    await Promise.resolve();
    const wave = render();
    expect((wave.match(/data-portrait-deferred="true"/g) ?? [])).toHaveLength(30);
    expect((wave.match(/data-loaded-portrait=/g) ?? [])).toHaveLength(2);

    admitted.delete(ids[1]!);
    const removed = render();
    expect((removed.match(/data-portrait-deferred="true"/g) ?? [])).toHaveLength(31);
    expect((removed.match(/data-loaded-portrait=/g) ?? [])).toHaveLength(1);
  });
});
