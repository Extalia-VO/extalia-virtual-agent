export interface PublicModel {
  path: string;
  sha256: string;
  bytes: number;
  license: 'MIT' | 'LicenseRef-RenderHub-Extended-Use';
  provenance: {
    kind: 'project-authored-export' | 'project-generated' | 'licensed-avatar-export';
    generator?: string;
    exporter?: string;
    note?: string;
  };
}
export const PUBLIC_MODEL_DIRECTORY: string;
export const PUBLIC_MODELS_MANIFEST: string;
export function readModelMetadata(file: string): Record<string, unknown>;
export function verifyPublicModels(root?: string): PublicModel[];
export function verifyModelBuild(directory: string, options?: { requireAll?: boolean; root?: string }): string[];
