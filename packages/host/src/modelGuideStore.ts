import { rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelSelectionGuide, normalizeModelSelectionGuideInput, type ModelSelectionGuide } from '@extalia/platform';
import { CorruptFileError, readJson, writeJsonAtomic } from './jsonStore.js';

/** One shared guide under the selected profile's configured data layout. No global-home access. */
export class ModelGuideStore {
  readonly file: string;
  constructor(configDirectory: string) { this.file = path.join(configDirectory, 'model-selection-guide.json'); }
  async get(): Promise<ModelSelectionGuide | null> {
    const missing = Symbol('missing-guide');
    const raw = await readJson<unknown>(this.file, missing);
    if (raw === missing) return null;
    try { return normalizeModelSelectionGuide(raw); }
    catch (error) { throw new CorruptFileError(this.file, error instanceof Error ? error.message : 'invalid guide'); }
  }
  async save(raw: unknown): Promise<ModelSelectionGuide | null> {
    const input = normalizeModelSelectionGuideInput(raw);
    if (input === null) { await rm(this.file, { force: true }); return null; }
    const guide = { ...input, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.file, guide);
    return guide;
  }
}
