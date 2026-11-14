import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptStep } from '@extalia/importers';
import { ObservedImageStore, OBSERVED_IMAGE_BUDGET, observedImageMime } from '../src/observedToolImages.js';
import { useTempDirs } from './helpers.js';

const temporary = useTempDirs();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sessionId = 's_imagefixture';
function imageSteps(selected: string, changes: Partial<Extract<TranscriptStep, { type: 'tool.result' }>> = {}): TranscriptStep[] {
  return [
    { type: 'tool.call', pos: 'call', tool: 'view_image', callId: 'image', imagePath: selected },
    { type: 'tool.result', pos: 'result', tool: 'view_image', callId: 'image', imagePath: selected, ok: true,
      attachments: [{ name: 'shot.png', kind: 'image', size: 0 }], ...changes },
  ];
}
const attachment = (steps: TranscriptStep[]) => { const result = steps.find(step => step.type === 'tool.result'); return result?.type === 'tool.result' ? result.attachments?.[0] : undefined; };
async function fixture() {
  const root = await temporary('extalia-tool-images-');
  const data = path.join(root, 'data'), projectRoot = path.join(root, 'project'), temporaryRoot = path.join(root, 'temporary'), outside = path.join(root, 'outside');
  await Promise.all([data, projectRoot, temporaryRoot, outside].map(folder => mkdir(folder)));
  const store = new ObservedImageStore(data, sessionId);
  return { root, data, projectRoot, temporaryRoot, outside, store, options: { sourceId: 'codex', projectRoot, temporaryRoot } };
}

describe('private observed tool images', () => {
  it('copies matched successful project and temporary images into opaque, immutable per-session refs', async () => {
    const f = await fixture(), selected = path.join(f.projectRoot, 'shot.png');
    await writeFile(selected, PNG);
    const result = await f.store.materialize(imageSteps(selected), f.options), file = attachment(result)!;
    expect(file).toMatchObject({ name: 'shot.png', kind: 'image', size: PNG.length, ref: digest(PNG) });
    expect(JSON.stringify(result.find(step => step.type === 'tool.result'))).not.toContain(selected);
    expect(JSON.stringify(result)).not.toContain(PNG.toString('base64'));
    expect(await f.store.preview(file.ref!)).toEqual({ mimeType: 'image/png', data: PNG.toString('base64') });
    const copy = path.join(f.data, 'observed-files', sessionId, file.ref!);
    expect(await readFile(copy)).toEqual(PNG);
    if (process.platform !== 'win32') expect((await stat(copy)).mode & 0o777).toBe(0o600);
    const other = path.join(f.temporaryRoot, 'temporary.png'); await writeFile(other, PNG);
    expect(attachment(await f.store.materialize(imageSteps(other), f.options))?.ref).toBe(file.ref);
    expect((await readdir(path.dirname(copy))).filter(name => /^[0-9a-f]{64}$/.test(name))).toHaveLength(1);
  });

  it('retains call-bound private copies across source deletion and restart but never shares them with another session', async () => {
    const f = await fixture(), selected = path.join(f.temporaryRoot, 'shot.png'); await writeFile(selected, PNG);
    const original = attachment(await f.store.materialize(imageSteps(selected), f.options))!;
    await rm(selected);
    const reopened = new ObservedImageStore(f.data, sessionId);
    expect(attachment(await reopened.materialize(imageSteps(selected), f.options))?.ref).toBe(original.ref);
    expect(await reopened.preview(original.ref!)).toBeDefined();
    expect(await new ObservedImageStore(f.data, 's_otherfixture').preview(original.ref!)).toBeUndefined();
    const changedSource = imageSteps(selected).map(step => ({ ...step, pos: `${step.pos}-different` }));
    expect(attachment(await reopened.materialize(changedSource, f.options))?.ref).toBeUndefined();
  });

  it('refuses newer pixels at a reused historical path while preserving captured copies and later matching views', async () => {
    const f = await fixture(), selected = path.join(f.projectRoot, 'reused.png');
    const oldTime = '2026-11-01T00:00:00.000Z', laterTime = '2026-11-01T00:00:05.000Z';
    await writeFile(selected, PNG); await utimes(selected, new Date(oldTime), new Date(oldTime));
    const oldSteps = imageSteps(selected, { at: oldTime });
    const oldRef = attachment(await f.store.materialize(oldSteps, f.options))!.ref!;
    const changed = Buffer.concat([PNG, Buffer.from('newer-pixels')]);
    await writeFile(selected, changed); await utimes(selected, new Date(laterTime), new Date(laterTime));
    const uncapturedOld = imageSteps(selected, { at: oldTime, callId: 'uncaptured' });
    const first = uncapturedOld[0]; if (first?.type === 'tool.call') first.callId = 'uncaptured';
    expect(attachment(await f.store.materialize(uncapturedOld, f.options))?.ref).toBeUndefined();
    expect(attachment(await f.store.materialize(oldSteps, f.options))?.ref).toBe(oldRef);
    expect(await f.store.preview(oldRef)).toEqual({ mimeType: 'image/png', data: PNG.toString('base64') });
    const laterRef = attachment(await f.store.materialize(imageSteps(selected, { at: laterTime }), f.options))!.ref!;
    expect(laterRef).toBe(digest(changed)); expect(laterRef).not.toBe(oldRef);
    expect(await f.store.preview(laterRef)).toEqual({ mimeType: 'image/png', data: changed.toString('base64') });
  });

  it('never reads unmatched, failed, wrong-source, mismatched-tool, traversal, URL or outside-root candidates', async () => {
    const f = await fixture(), selected = path.join(f.outside, 'shot.png'); await writeFile(selected, PNG);
    const admitted = path.join(f.projectRoot, 'shot.png'); await writeFile(admitted, PNG);
    for (const candidate of [selected, path.join(f.projectRoot, '..', 'outside', 'shot.png'), 'https://example.com/shot.png', 'file:///projects/example/shot.png'])
      expect(attachment(await f.store.materialize(imageSteps(candidate), f.options))?.ref).toBeUndefined();
    for (const changes of [{ ok: false }, { callId: 'unmatched' }, { tool: 'read_file' }])
      expect(attachment(await f.store.materialize(imageSteps(admitted, changes), f.options))?.ref).toBeUndefined();
    expect(attachment(await f.store.materialize(imageSteps(admitted), { ...f.options, sourceId: 'claude-code' }))?.ref).toBeUndefined();
    expect(attachment(await f.store.materialize(imageSteps(admitted, { imagePath: path.join(f.projectRoot, 'different.png') }), f.options))?.ref).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('rejects symlink leaves, symlink child directories and a replaced private copy', async () => {
    const f = await fixture(), original = path.join(f.projectRoot, 'original.png'); await writeFile(original, PNG);
    const alias = path.join(f.projectRoot, 'alias.png'); await symlink(original, alias);
    expect(attachment(await f.store.materialize(imageSteps(alias), f.options))?.ref).toBeUndefined();
    const nested = path.join(f.projectRoot, 'nested'); await symlink(f.outside, nested);
    await writeFile(path.join(f.outside, 'outside.png'), PNG);
    expect(attachment(await f.store.materialize(imageSteps(path.join(nested, 'outside.png')), f.options))?.ref).toBeUndefined();
    const ref = attachment(await f.store.materialize(imageSteps(original), f.options))!.ref!;
    const copy = path.join(f.data, 'observed-files', sessionId, ref); await rm(copy); await symlink(original, copy);
    expect(await f.store.preview(ref)).toBeUndefined();
  });

  it('preserves names when pixels, size, signatures or storage quota refuse a preview', async () => {
    const f = await fixture();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1), huge = Buffer.from(PNG); huge.writeUInt32BE(20_000, 16);
    expect(f.store.keep(oversized.toString('base64'))).toBeUndefined();
    expect(f.store.keep(huge.toString('base64'))).toBeUndefined();
    expect(f.store.keep(Buffer.from('<svg></svg>').toString('base64'))).toBeUndefined();
    expect(observedImageMime(PNG)).toBe('image/png');
    for (let index = 0; index < OBSERVED_IMAGE_BUDGET.files; index++) expect(f.store.keep(Buffer.concat([PNG, Buffer.from([index])]).toString('base64'))).toBeDefined();
    expect(f.store.keep(Buffer.concat([PNG, Buffer.from('new')]).toString('base64'))).toBeUndefined();
    const selected = path.join(f.projectRoot, 'after-quota.png'); await writeFile(selected, PNG);
    expect(attachment(await f.store.materialize(imageSteps(selected), f.options))).toEqual({ name: 'shot.png', kind: 'image', size: 0 });
  });

  it('does not trust a renderer hash, stored-file tampering or incoming parser refs', async () => {
    const f = await fixture(), ref = f.store.keep(PNG.toString('base64'))!;
    const copy = path.join(f.data, 'observed-files', sessionId, ref); await writeFile(copy, Buffer.concat([PNG, Buffer.from('changed')]));
    expect(await f.store.preview(ref)).toBeUndefined();
    const fake = 'a'.repeat(64); await writeFile(path.join(path.dirname(copy), fake), PNG);
    expect(await f.store.preview(fake)).toBeUndefined();
    const steps: TranscriptStep[] = [{ type: 'tool.result', pos: 'forged', ok: true, attachments: [{ name: 'shot.png', kind: 'image', size: 68, ref }] }];
    expect(attachment(await f.store.materialize(steps, f.options))?.ref).toBeUndefined();
  });

  it.each(['{invalid', ' '.repeat(100_001)])('fails closed on an invalid or oversized existing manifest', async invalid => {
    const f = await fixture(), originalRef = f.store.keep(PNG.toString('base64'))!;
    const folder = path.join(f.data, 'observed-files', sessionId);
    await writeFile(path.join(folder, 'index.json'), invalid);
    const reopened = new ObservedImageStore(f.data, sessionId);
    expect(await reopened.preview(originalRef)).toBeUndefined();
    expect(reopened.keep(Buffer.concat([PNG, Buffer.from('another')]).toString('base64'))).toBeUndefined();
    expect((await readdir(folder)).filter(name => /^[0-9a-f]{64}$/.test(name))).toEqual([originalRef]);
  });

  it('does not admit an undurable ref or leave a new blob/temp file after manifest publication fails', async () => {
    const f = await fixture();
    // Load the empty state before replacing its future manifest path with a directory.
    expect(await f.store.preview('a'.repeat(64))).toBeUndefined();
    const folder = path.join(f.data, 'observed-files', sessionId);
    await mkdir(path.join(folder, 'index.json'), { recursive: true });
    expect(f.store.keep(PNG.toString('base64'))).toBeUndefined();
    expect(f.store.keep(PNG.toString('base64'))).toBeUndefined();
    expect(await readdir(folder)).toEqual(['index.json']);
    await rm(path.join(folder, 'index.json'), { recursive: true });
    expect(f.store.keep(PNG.toString('base64'))).toBe(digest(PNG));
    expect(await new ObservedImageStore(f.data, sessionId).preview(digest(PNG))).toBeDefined();
  });

  it('reconciles a bounded legacy content-addressed copy inventory before accepting new data', async () => {
    const f = await fixture(), folder = path.join(f.data, 'observed-files', sessionId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, digest(PNG)), PNG);
    const reopened = new ObservedImageStore(f.data, sessionId);
    expect(await reopened.preview(digest(PNG))).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(folder, 'index.json'), 'utf8'))).toMatchObject({ files: [], legacy: [{ ref: digest(PNG), size: PNG.length }] });
    expect(reopened.keep(PNG.toString('base64'))).toBe(digest(PNG));
    expect(await reopened.preview(digest(PNG))).toBeDefined();
  });

  it('does not charge already admitted inline images against the next bounded materialization batch', async () => {
    const f = await fixture();
    const steps: TranscriptStep[] = [0, 1, 2].map(index => {
      const bytes = Buffer.alloc(4 * 1024 * 1024); PNG.copy(bytes); bytes[bytes.length - 1] = index;
      return { type: 'tool.result', pos: `image-${index}`, callId: `call-${index}`, ok: true,
        attachments: [{ name: `${index}.png`, kind: 'image', size: bytes.length, mimeType: 'image/png', data: bytes.toString('base64') }] };
    });
    const first = await f.store.materialize(steps, f.options);
    expect(first.filter(step => step.type === 'tool.result' && step.attachments?.[0]?.ref)).toHaveLength(2);
    expect(f.store.hasPending).toBe(true);
    const second = await f.store.materialize(steps, f.options);
    expect(second.filter(step => step.type === 'tool.result' && step.attachments?.[0]?.ref)).toHaveLength(3);
    expect(f.store.hasPending).toBe(false);
  });

  it('advances past more invalid images than the bounded negative cache can retain', async () => {
    const f = await fixture();
    const steps: TranscriptStep[] = Array.from({ length: 600 }, (_, index) => ({ type: 'tool.result', pos: `bad-${index}`, ok: true,
      attachments: [{ name: 'invalid.png', kind: 'image', size: 2, mimeType: 'image/png', data: Buffer.from([index & 255, index >>> 8]).toString('base64') }] }));
    steps.push({ type: 'tool.result', pos: 'valid-tail', ok: true, attachments: [{ name: 'tail.png', kind: 'image', size: PNG.length, mimeType: 'image/png', data: PNG.toString('base64') }] });
    let result: TranscriptStep[] = [];
    for (let tick = 0; tick < 40 && (!tick || f.store.hasPending); tick++) result = await f.store.materialize(steps, { ...f.options, revision: 'finished-source' });
    const tail = result.at(-1);
    expect(tail?.type === 'tool.result' && tail.attachments?.[0]?.ref).toBe(digest(PNG));
    expect(f.store.hasPending).toBe(false);
  });

  it('retries a byte-budget-deferred local image before moving past a later smaller image', async () => {
    const f = await fixture(), steps: TranscriptStep[] = [];
    for (let index = 0; index < 4; index++) {
      const selected = path.join(f.projectRoot, `${index}.png`), bytes = Buffer.alloc(index === 3 ? PNG.length + 1 : 4 * 1024 * 1024);
      PNG.copy(bytes); bytes[bytes.length - 1] = index; await writeFile(selected, bytes);
      steps.push(...imageSteps(selected).map(step => ({ ...step, pos: `${step.pos}-${index}`, callId: `call-${index}` })));
    }
    const first = await f.store.materialize(steps, { ...f.options, revision: 'finished-source' });
    expect(first.filter(step => step.type === 'tool.result' && step.attachments?.[0]?.ref)).toHaveLength(3);
    expect(f.store.hasPending).toBe(true);
    const second = await f.store.materialize(steps, { ...f.options, revision: 'finished-source' });
    expect(second.filter(step => step.type === 'tool.result' && step.attachments?.[0]?.ref)).toHaveLength(4);
    expect(f.store.hasPending).toBe(false);
  });

  it('materializes staged prompt images only inside stagedAttachmentsRoot', async () => {
    const f = await fixture();
    const stagedRoot = path.join(f.data, 'attachments', sessionId, 'files');
    const stagedDir = path.join(stagedRoot, 'att_1234567890ab');
    await mkdir(stagedDir, { recursive: true });
    const stagedFile = path.join(stagedDir, 'Screenshot 2026-11-13 at 17.35.49.png');
    const outsideFile = path.join(f.outside, 'secret.png');
    await Promise.all([writeFile(stagedFile, PNG), writeFile(outsideFile, PNG)]);

    const [stagedPrompt, outsidePrompt] = await f.store.materialize([
      {
        type: 'prompt',
        pos: 'prompt-1',
        text: `[Attached file: Screenshot 2026-11-13 at 17.35.49.png (${stagedFile})]\n\nCheck thumbnail`,
      },
      {
        type: 'prompt',
        pos: 'prompt-2',
        text: `[Attached file: secret.png (${outsideFile})]\n\nShould stay unmaterialized`,
      },
    ], { ...f.options, stagedAttachmentsRoot: stagedRoot });

    expect(stagedPrompt?.type === 'prompt' ? stagedPrompt.attachments : undefined).toEqual([
      { name: 'Screenshot 2026-11-13 at 17.35.49.png', kind: 'image', size: PNG.length, mimeType: 'image/png', ref: digest(PNG) },
    ]);
    expect(outsidePrompt?.type === 'prompt' ? outsidePrompt.attachments : undefined).toBeUndefined();
    expect(await f.store.preview(digest(PNG))).toEqual({ mimeType: 'image/png', data: PNG.toString('base64') });
  });
});
