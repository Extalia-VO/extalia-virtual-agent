import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type * as ReactTypes from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const sourceGate = vi.hoisted(() => ({
  bodyReady: false, hairReady: false,
  resolveBody: null as null | (() => void), resolveHair: null as null | (() => void),
}));

vi.mock('../src/office/scene/avatars/sourceAssets', () => ({
  sourceAvatarUrls: () => ({ body: '/selected/body.glb', hair: '/selected/hair.glb' }),
}));

vi.mock('../src/office/scene/avatars/hairAssets', () => ({
  sourceHairAsset: () => ({ group: 'shared', assetKey: 'selected-hair' }),
}));

vi.mock('../src/office/scene/avatars/SourceHumanoid', async () => {
  const React = await vi.importActual<typeof ReactTypes>('react');
  let resolveBody!: () => void, resolveHair!: () => void;
  const bodyPending = new Promise<void>(resolve => { resolveBody = resolve; });
  const hairPending = new Promise<void>(resolve => { resolveHair = resolve; });
  sourceGate.resolveBody = resolveBody;
  sourceGate.resolveHair = resolveHair;
  return {
    SourceHumanoid: () => {
      if (!sourceGate.bodyReady) throw bodyPending;
      if (!sourceGate.hairReady) throw hairPending;
      return React.createElement('source-avatar', { 'data-model': 'selected' });
    },
  };
});

import { CharacterBody } from '../src/office/scene/avatars/OfficeCharacter';

function renderSourceBranch(): string {
  return renderToStaticMarkup(createElement(CharacterBody, {
    id: 'loading-test-agent', seated: false, typing: false, reducedMotion: true,
  }));
}

describe('source avatar loading boundary', () => {
  beforeEach(() => {
    sourceGate.bodyReady = false;
    sourceGate.hairReady = false;
  });

  it('keeps the procedural body hidden until both selected GLB assets are ready', async () => {
    const bodyPending = renderSourceBranch();
    expect(bodyPending).not.toContain('<mesh');
    expect(bodyPending).not.toContain('<source-avatar');

    sourceGate.resolveBody?.();
    sourceGate.bodyReady = true;
    await Promise.resolve();
    const hairPending = renderSourceBranch();
    expect(hairPending).not.toContain('<mesh');
    expect(hairPending).not.toContain('<source-avatar');

    sourceGate.resolveHair?.();
    sourceGate.hairReady = true;
    await Promise.resolve();
    const ready = renderSourceBranch();
    expect(ready).toContain('<source-avatar data-model="selected"></source-avatar>');
    expect(ready).not.toContain('<mesh');
  });
});
