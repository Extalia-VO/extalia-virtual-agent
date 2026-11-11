import type { Object3D } from 'three';

interface SourceVisibility { readonly visible: boolean }
const sources = new WeakMap<Object3D, SourceVisibility>();

/** Intended source visibility survives React replacing a mesh's userData. */
export const modelBatchSourceVisibility = (mesh: Object3D): boolean | undefined => sources.get(mesh)?.visible;

export function registerModelBatchSource(mesh: Object3D, source: SourceVisibility): void {
  sources.set(mesh, source);
}

export function releaseModelBatchSource(mesh: Object3D, source: SourceVisibility): void {
  if (sources.get(mesh) === source) sources.delete(mesh);
}
