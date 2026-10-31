import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { footwearFloorContact, ownedFootwearSoles, sourceFootwearProfiles, wardrobeFootSoleProfile } from '../src/office/scene/avatars/sourceNativeFootwear';
import { createSeatedLegPose, floorSeatedKnee, seatedLegPose } from '../src/office/scene/avatars/seatedPose';

function originalShoes(indexed: boolean) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    -.08, 0, .1, -.07, .02, .1, -.09, .01, .2,
    .08, .006, .1, .07, .02, .1, .09, .01, .2,
    0, -.5, 0, 0, -.4, 0, .01, -.5, 0, // non-shoe faces must not affect the profile
  ], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: 9 }, () => [1, 0, 0, 0]).flat(), 4));
  if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  geometry.addGroup(0, 6, 0); geometry.addGroup(6, 3, 1);
  const left = new Bone(); left.name = 'leftFoot'; const right = new Bone(); right.name = 'rightFoot';
  const mesh = new SkinnedMesh(geometry, [new MeshStandardMaterial({ name: 'OriginalShoes_CasualJeans' }), new MeshStandardMaterial({ name: 'OriginalBottom_Jeans' })]);
  mesh.bind(new Skeleton([left, right]));
  return mesh;
}

describe('actual original-bottom shoe sole profiles', () => {
  it.each([true, false])('measures only shoe faces per bound foot without mutating geometry (indexed %s)', indexed => {
    const mesh = originalShoes(indexed), before = [...mesh.geometry.getAttribute('position').array];
    const soles = ownedFootwearSoles(mesh)!;
    expect(soles.get('leftFoot')).toBeCloseTo(0);
    expect(soles.get('rightFoot')).toBeCloseTo(.006);
    expect(ownedFootwearSoles(mesh)).toBe(soles);
    expect([...mesh.geometry.getAttribute('position').array]).toEqual(before);
    mesh.bindMatrix.copy(new Matrix4().makeTranslation(0, .02, 0));
    expect(ownedFootwearSoles(mesh)!.get('leftFoot')).toBeCloseTo(.02);
  });

  it('uses the selected sneakers at floor zero rather than the hidden native negative heel soles', () => {
    const owned = ownedFootwearSoles(originalShoes(true))!;
    const native = new Map([['leftFoot', -.078], ['rightFoot', -.078]]);
    const profiles = new Map([['ScanOutfit', native], ['WardrobePieceBottom', owned]]);
    const selected = wardrobeFootSoleProfile(profiles, 'WardrobePieceBottom', false)!;
    expect(selected).toBe(owned);
    expect(footwearFloorContact(selected).standingOffset).toBeCloseTo(0);
    expect(footwearFloorContact(wardrobeFootSoleProfile(profiles, 'ScanOutfit', false)).standingOffset).toBeCloseTo(.078);
  });
  it("selects a full original set's actual shoe profile and preserves legacy or native-footwear fallbacks", () => {
    const mesh = originalShoes(true); mesh.name = 'ScanOutfitModel';
    const native = new Map([['leftFoot', -.078], ['rightFoot', -.078]]);
    const legacy = new Map([['leftFoot', -.02], ['rightFoot', -.02]]);
    const existing = new Map([['ScanOutfit', native], ['ScanOutfitModel', legacy]]);
    const full = sourceFootwearProfiles(existing, [mesh], { fullOutfit: true, bottom: false });
    expect(full.slot).toBe('ScanOutfitModel');
    expect(wardrobeFootSoleProfile(full.profiles, full.slot, false)!.get('leftFoot')).toBeCloseTo(0);
    expect(wardrobeFootSoleProfile(full.profiles, full.slot, true)).toBe(native);
    expect(sourceFootwearProfiles(existing, [mesh], { fullOutfit: false, bottom: false }).profiles.get('ScanOutfitModel')).toBe(legacy);
    (mesh.material as MeshStandardMaterial[])[0]!.name = 'OfficeShoes_Legacy';
    const unchanged = sourceFootwearProfiles(existing, [mesh], { fullOutfit: true, bottom: false });
    expect(unchanged.slot).toBeUndefined();
    expect(unchanged.profiles.get('ScanOutfitModel')).toBe(legacy);
  });

});

describe('signed source footwear floor contact', () => {
  it.each([.02082, -.078])('places the lowest owned sole on the standing floor (rest height %s)', sole => {
    const mesh = originalShoes(true); mesh.bindMatrix.makeTranslation(0, sole, 0);
    const before = [...mesh.geometry.getAttribute('position').array];
    const contact = footwearFloorContact(ownedFootwearSoles(mesh));
    expect(contact.standingOffset).toBeCloseTo(-sole);
    expect(contact.standingOffset + contact.soleByFoot.get('leftFoot')!).toBeCloseTo(0);
    expect(contact.standingOffset + contact.soleByFoot.get('rightFoot')!).toBeGreaterThanOrEqual(0);
    expect([...mesh.geometry.getAttribute('position').array]).toEqual(before);
  });

  it('keeps asymmetric sole profiles per foot while grounding the lowest standing sole', () => {
    const contact = footwearFloorContact(new Map([['leftFoot', .02082], ['rightFoot', .02682]]));
    expect(contact.standingOffset).toBeCloseTo(-.02082);
    expect(contact.standingOffset + contact.soleByFoot.get('leftFoot')!).toBeCloseTo(0);
    expect(contact.standingOffset + contact.soleByFoot.get('rightFoot')!).toBeCloseTo(.006);
    expect(.12 - contact.soleByFoot.get('leftFoot')!).toBeCloseTo(.09918);
    expect(.12 - contact.soleByFoot.get('rightFoot')!).toBeCloseTo(.09318);
  });

  it.each([undefined, new Map<string, number>(), new Map([['leftFoot', NaN], ['rightFoot', Infinity]]),
    new Map([['leftFoot', -20], ['rightFoot', 20]]), new Map([['hips', -5]])])('falls back to origin for missing or invalid measurements (%s)', soles => {
    const contact = footwearFloorContact(soles);
    expect(contact.standingOffset).toBeCloseTo(0);
    expect([...contact.soleByFoot.values()]).toEqual([0, 0]);
  });

  it('retains the known foot and a safe zero fallback when only one measurement is available', () => {
    const contact = footwearFloorContact(new Map([['leftFoot', .02082], ['rightFoot', NaN]]));
    expect(contact.standingOffset).toBeCloseTo(0);
    expect(contact.soleByFoot.get('leftFoot')).toBeCloseTo(.02082);
    expect(contact.soleByFoot.get('rightFoot')).toBe(0);
  });

  it.each([.02082, -.078])('solves seated soles to the floor without moving the seat or desk contact (sole %s)', sole => {
    const ankleRest = .12, thigh = .43, shin = .43, scale = .92, seat = .42;
    const contact = footwearFloorContact(new Map([['leftFoot', sole], ['rightFoot', sole + .004]]));
    for (const foot of ['leftFoot', 'rightFoot']) {
      const sourceSole = contact.soleByFoot.get(foot)!, ankle = (ankleRest - sourceSole) * scale;
      const pose = seatedLegPose(seat, .26, .11 * scale, thigh * scale, shin * scale, ankle, .08 * scale, createSeatedLegPose());
      expect(pose.hip).toBeCloseTo(seat + .11 * scale);
      expect(pose.ankleY + (sourceSole - ankleRest) * scale).toBeCloseTo(0);
      // A relaxed activity may lower the knee; the floor guard still protects its shoe.
      const pitch = pose.thigh + .12;
      const knee = floorSeatedKnee(pitch, -pitch, pose.hip, thigh * scale, shin * scale, ankle, 1);
      const posedAnkle = pose.hip - Math.cos(pitch) * thigh * scale - Math.cos(pitch + knee) * shin * scale;
      expect(posedAnkle + (sourceSole - ankleRest) * scale).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('lets shorter legs hang from a high seat rather than lowering the seated body', () => {
    const sole = .02082, ankleRest = .12, seat = .62;
    const pose = seatedLegPose(seat, .26, .11, .4, .4, ankleRest - sole, .08, createSeatedLegPose());
    expect(pose.hip).toBeCloseTo(seat + .11);
    expect(pose.ankleY + sole - ankleRest).toBeGreaterThan(.1);
  });
});
