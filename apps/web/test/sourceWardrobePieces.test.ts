import { BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { attachWardrobePieces, wardrobePieceHasFootwear } from '../src/office/scene/avatars/sourceWardrobePieces';
import { wardrobeReplacementParts } from '../src/office/scene/avatars/sourceWardrobeGeometry';

describe('independent fitted garment attachment', () => {
  it('wears an original jacket over the native upper outfit when no fitted top is selected', () => {
    const jacket = new Group(), attached: string[] = [];
    const loaded = attachWardrobePieces({ outer: jacket }, (slot, scene) => {
      attached.push(slot);
      expect(scene).toBe(jacket);
      return true;
    });
    expect(attached).toEqual(['outer']);
    expect(loaded).toEqual({ outer: true });
    // Native shirt/vest coverage remains beneath the jacket, whose source inner shirt may be incomplete.
    expect(wardrobeReplacementParts(loaded, true, 'cloth-jacket')).toEqual({ outer: false });
  });

  it('keeps other selected pieces when top attachment fails, while retaining native chest coverage', () => {
    const attempted: string[] = [];
    const loaded = attachWardrobePieces({ top: new Group(), bottom: new Group(), outer: new Group() }, slot => {
      attempted.push(slot);
      return slot !== 'top';
    });
    expect(attempted).toEqual(['top', 'bottom', 'outer']);
    expect(loaded).toEqual({ bottom: true, outer: true });
    expect(wardrobeReplacementParts(loaded, true, 'cloth-jacket')).toEqual({ bottom: true, outer: false });
  });
  it('distinguishes a standalone bottom from one with its own footwear using actual material roles', () => {
    const bare = new Group();
    bare.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ name: 'OriginalBottom_Jeans' })));
    expect(wardrobePieceHasFootwear(bare)).toBe(false);
    const complete = new Group(), nested = new Group();
    nested.add(new Mesh(new BufferGeometry(), [new MeshStandardMaterial({ name: 'OriginalBottom_Jeans' }), new MeshStandardMaterial({ name: 'OfficeShoes_Formal' })]));
    complete.add(nested);
    expect(wardrobePieceHasFootwear(complete)).toBe(true);
    expect(wardrobePieceHasFootwear(complete)).toBe(true);
    const originals = new Group();
    originals.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ name: 'OriginalShoes_CasualJeans' })));
    expect(wardrobePieceHasFootwear(originals)).toBe(true);
  });

});
