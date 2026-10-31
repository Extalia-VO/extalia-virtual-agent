export interface PublicModel {
  path: string;
  sha256: string;
  bytes: number;
  license: 'MIT' | 'LicenseRef-RenderHub-Extended-Use' | 'CC-BY-4.0' | 'CC-BY-NC-4.0' | 'CC-BY-NC-SA-4.0'
    | 'LicenseRef-Sketchfab-Standard' | 'LicenseRef-Owner-Provided-Unverified';
  provenance: {
    kind: 'project-authored-export' | 'project-generated' | 'licensed-avatar-export' | 'third-party-derived';
    generator?: string;
    exporter?: string;
    note?: string;
  };
}
export const PUBLIC_MODEL_DIRECTORY: string;
export const PUBLIC_MODELS_MANIFEST: string;
export const PUBLIC_SOURCE_GARMENTS: string;
export interface SourceMaterialReceipt {
  sourceMaterialIndex: number;
  graphSHA256: string;
  requiredImages: { textureInfo: string; sha256: string; bytes: number }[];
  requiredUVSets: number[];
  overrides: { alphaMode?: 'OPAQUE' };
}
export interface SourceGarmentProfile {
  path: string;
  id: string;
  group: 'male' | 'female';
  mode: 'outfit' | 'top' | 'bottom' | 'outer';
  source: { path: string; sha256: string };
  fittedSHA256: string;
  sha256: string;
  triangles: number;
  bytes: number;
  budgets: { triangles: number; bytes: number };
  fitChecks: { rest: true; walk: true; sit: true; reach: true; sourceAppearance: true };
  materials: Record<string, SourceMaterialReceipt>;
  materialGraphSHA256: string;
  imageSHA256s: string[];
  license: 'CC-BY-4.0';
  componentLicenses: { sourceGarment: 'CC-BY-4.0'; referenceAvatarRigAndContext: 'LicenseRef-RenderHub-Extended-Use' };
  attribution: { title: string; author: string; source: string; license: string };
}
export function readModelMetadata(file: string): Record<string, unknown>;
export function readSourceGarmentProfiles(root?: string): SourceGarmentProfile[];
export function verifySourceGarmentMaterialReceipts(file: string, receipts: Record<string, SourceMaterialReceipt>): void;
export function verifyPublicModels(root?: string): PublicModel[];
export function verifyModelBuild(directory: string, options?: { requireAll?: boolean; root?: string }): string[];
