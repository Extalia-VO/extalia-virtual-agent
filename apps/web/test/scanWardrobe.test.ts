import { describe, expect, it } from 'vitest';
import { scanAccessorySlots, scanOutfitSlot } from '../src/office/scene/avatars/wardrobe';

describe('scanned outfits and accessories on local Blender bodies', () => {
  const both = new Set(['Body', 'ScanOutfit', 'ScanOutfitCasual', 'AccGlasses']);
  it('wears the casual outfit for casual styles when the body has one, the office outfit otherwise', () => {
    expect(scanOutfitSlot('casual', both)).toBe('ScanOutfitCasual');
    expect(scanOutfitSlot('technical', both)).toBe('ScanOutfitCasual');
    expect(scanOutfitSlot('executive', both)).toBe('ScanOutfit');
    expect(scanOutfitSlot('casual', new Set(['Body', 'ScanOutfit']))).toBe('ScanOutfit');
    expect(scanOutfitSlot('ceo', new Set(['Body']))).toBeUndefined();
  });

  it('shows only the accessories the look wears', () => {
    expect([...scanAccessorySlots({ glasses: true, watch: false, badge: true })].sort()).toEqual(['AccBadge', 'AccGlasses']);
    expect([...scanAccessorySlots({ earrings: 'studs', headphones: true, watch: true })].sort()).toEqual(['AccEarrings', 'AccHeadphones']);
    // The watch sits on the bare wrist: only the casual outfit (rolled sleeves) shows it.
    expect(scanAccessorySlots({ watch: true }, 'ScanOutfitCasual').has('AccWatch')).toBe(true);
    expect(scanAccessorySlots({ watch: true }, 'ScanOutfit').has('AccWatch')).toBe(false);
    expect(scanAccessorySlots(undefined).size).toBe(0);
  });
});
