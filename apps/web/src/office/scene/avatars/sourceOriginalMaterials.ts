import { type Color, type MeshStandardMaterial } from 'three';
import type { AvatarClothingConfig } from './appearance';
import { staffRoleOfModel } from './outfitCatalog';

const originalColors = new WeakMap<MeshStandardMaterial, Color>();
const ROLES = /^Original(Top|Bottom|Outer|Accent|Shoes)(?:_|$)/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Preserve a source garment's authored material unless the user explicitly overrides its zone. */
export function tintOriginalGarmentMaterial(material: MeshStandardMaterial, clothing: AvatarClothingConfig | undefined): boolean {
  const role = ROLES.exec(material.name)?.[1];
  if (!role) return false;
  let original = originalColors.get(material);
  if (!original) { original = material.color.clone(); originalColors.set(material, original); }
  // Staff baseline palettes are role defaults, not user edits to the source garment.
  const fixedUniformZone = staffRoleOfModel(clothing?.model) !== undefined && ['Top', 'Bottom', 'Outer'].includes(role);
  const override = fixedUniformZone ? undefined : role === 'Top' ? clothing?.top : role === 'Bottom' ? clothing?.bottom
    : role === 'Outer' ? clothing?.outerwear : role === 'Shoes' ? clothing?.shoes : clothing?.accent;
  if (override && HEX_COLOR.test(override)) material.color.set(override);
  else material.color.copy(original);
  return true;
}
