import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RustSkillMarket, type SkillMarketProcess } from '../src/daemon/skillMarket.js';

const SCHEMA = 'extalia.skill-market.v1';
const UUID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
class Child extends EventEmitter implements SkillMarketProcess {
  pid: number | undefined = 123;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  input = ''; signals: string[] = [];
  constructor() { super(); this.stdin.on('data', chunk => { this.input += String(chunk); }); }
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(String(signal)); return true; }
  reply(result: unknown, extra: Record<string, unknown> = {}): void {
    const request = JSON.parse(this.input) as { operation: string; requestId: string };
    this.stdout.write(JSON.stringify({ schema: SCHEMA, requestId: request.requestId, operation: request.operation, outcome: 'ok', result, ...extra }));
  }
  fail(code: string, status?: number): void {
    const request = JSON.parse(this.input) as { requestId: string };
    this.stdout.write(JSON.stringify({ schema: SCHEMA, requestId: request.requestId, outcome: 'error', code, ...(status ? { status } : {}) }));
  }
  close(code = 0): void { this.emit('close', code, null); }
}
const children: Child[] = [];
afterEach(() => { while (children.length) children.pop()!.close(1); });
function fixture() {
  const launches: { binary: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const client = new RustSkillMarket({ binary: () => '/native/extalia-daemon', directory: '/profile/skill-market', workingDirectory: '/profile', clientVersion: 'test',
    env: { HOME: '/private/home', PATH: '/private/bin', HTTPS_PROXY: 'http://proxy.invalid', PRIVATE_TOKEN: 'secret', TMPDIR: '/temporary' },
    spawn: (binary, args, options) => { const child = new Child(); children.push(child); launches.push({ binary, args, ...options }); return child; } });
  return { client, launches };
}
const previewResult = { reviewId: UUID, expiresAt: '2026-11-12T00:00:00.000Z', repository: 'acme/skills', commit: 'b'.repeat(40), directory: 'skill-one',
  sourceRef: `github:acme/skills@${'b'.repeat(40)}#skill-one`, files: [{ path: 'SKILL.md', size: 4, sha256: SHA }], totalBytes: 4, treeSha256: SHA, warnings: [] };

describe('Rust Skills Market supervisor', () => {
  it('uses minimal environment, bounded stdin and strict correlated search reply, retaining admission until close', async () => {
    const { client, launches } = fixture(); let settled = false;
    const pending = client.search('react').finally(() => { settled = true; });
    const child = children[0]!;
    expect(launches).toEqual([{ binary: '/native/extalia-daemon', args: ['--skill-market'], cwd: '/profile', env: { TMPDIR: '/temporary' } }]);
    expect(JSON.parse(child.input)).toMatchObject({ schema: SCHEMA, operation: 'search', query: 'react', directory: '/profile/skill-market', timeoutMs: 45000 });
    expect(child.stdin.writableEnded).toBe(true);
    const result = { provider: 'skills-sh', query: 'react', entries: [{ id: 'acme/skills/react', name: 'React', source: 'acme/skills', installs: 42, url: 'https://skills.sh/acme/skills/react' }], cached: false, stale: false };
    child.reply(result); await setImmediate();
    expect(settled).toBe(false); expect(client.pendingCount).toBe(1);
    child.close(); await expect(pending).resolves.toEqual(result);
    expect(client.pendingCount).toBe(0); await client.close();
  });

  it('validates each operation result and maps discard to void', async () => {
    const { client } = fixture();
    const preview = client.preview({ repository: 'acme/skills', skill: 'skill-one' });
    children.at(-1)!.reply(previewResult); children.at(-1)!.close();
    await expect(preview).resolves.toEqual(previewResult);
    const stage = client.stage(UUID); children.at(-1)!.reply({ path: `market-${UUID}`, treeSha256: SHA, sourceRef: previewResult.sourceRef }); children.at(-1)!.close();
    await expect(stage).resolves.toEqual({ path: `market-${UUID}`, treeSha256: SHA, sourceRef: previewResult.sourceRef });
    const discard = client.discard(UUID); children.at(-1)!.reply({ discarded: true }); children.at(-1)!.close(); await expect(discard).resolves.toBeUndefined();
  });

  it.each(['rate_limited', 'review_expired', 'integrity', 'invalid_manifest'])('accepts the Rust error envelope without operation and preserves %s', async code => {
    const { client } = fixture(); const request = client.preview({ repository: 'acme/skills', skill: 'skill-one' }).catch(error => error);
    const child = children.at(-1)!; child.fail(code, 429); child.close();
    await expect(request).resolves.toMatchObject({ message: expect.stringContaining(code) });
    expect(children).toHaveLength(1);
    await client.close();
  });

  it('retains declared permissions and unevaluated compatibility with explicit omission counts', async () => {
    const { client } = fixture();
    const pending = client.preview({ repository: 'acme/skills', skill: 'skill-one' });
    const manifest = {
      id: 'skill-one', version: '1.2.0', inferred: false, riskClass: 'tool_using',
      permissions: Array.from({ length: 32 }, (_, index) => ({ capability: 'filesystem_read', scope: `docs/${index}/*.md` })),
      permissionsTotal: 35, compatibility: [{ id: 'runtime.test', range: '>=1.2 <3' }], compatibilityTotal: 1,
    };
    children.at(-1)!.reply({ ...previewResult, manifest }); children.at(-1)!.close();
    await expect(pending).resolves.toMatchObject({ manifest });

    const malformed = client.preview({ repository: 'acme/skills', skill: 'skill-one' }).catch(error => error);
    children.at(-1)!.reply({ ...previewResult, manifest: { ...manifest, permissionsTotal: 0 } }); children.at(-1)!.close();
    await expect(malformed).resolves.toMatchObject({ message: expect.stringContaining('invalid_response') });
    await client.close();
  });

  it('accepts bounded license metadata containing multiple notices', async () => {
    const { client } = fixture();
    const preview = client.preview({ repository: 'acme/skills', skill: 'skill-one' });
    const license = Array.from({ length: 4 }, (_, index) => `License notice ${index + 1}: ${'MIT '.repeat(35)}`).join('; ');
    children.at(-1)!.reply({ ...previewResult, license }); children.at(-1)!.close();
    await expect(preview).resolves.toMatchObject({ license });
    await client.close();
  });

  it('rejects malformed, mismatched, replayed, oversized and failed replies with sanitized errors', async () => {
    const { client } = fixture();
    const malformed = client.preview({ repository: 'acme/skills', skill: 'skill-one' }).catch(error => error);
    children.at(-1)!.reply({ ...previewResult, sourceRef: 'https://untrusted.invalid/file' }); children.at(-1)!.close();
    expect(await malformed).toMatchObject({ message: expect.stringContaining('invalid_response') });
    const replayed = client.search('react').catch(error => error);
    children.at(-1)!.reply({ provider: 'skills-sh', query: 'react', entries: [], cached: false, stale: false }, { requestId: '22222222-2222-4222-8222-222222222222' }); children.at(-1)!.close();
    expect(await replayed).toMatchObject({ message: expect.stringContaining('invalid_response') });
    const oversized = client.search('react').catch(error => error); children.at(-1)!.stdout.write(Buffer.alloc(2_750_001, 120));
    expect(client.pendingCount).toBe(1); children.at(-1)!.close(); expect(await oversized).toMatchObject({ message: expect.stringContaining('too_large') });
    const failed = client.preview({ repository: 'acme/skills', skill: 'skill-one' }).catch(error => error);
    children.at(-1)!.fail('private-provider-detail'); children.at(-1)!.close();
    expect(await failed).toMatchObject({ message: expect.not.stringContaining('private-provider-detail') });
    await client.close();
  });

  it('limits active children to two and keeps admission through cancellation until close', async () => {
    const { client } = fixture(); const controller = new AbortController();
    const a = client.search('react', false, controller.signal).catch(error => error);
    const b = client.search('rust').catch(error => error);
    await expect(client.search('skills')).rejects.toThrow(/storage/);
    expect(children).toHaveLength(2); controller.abort(); expect(children[0]!.signals).toEqual(['SIGKILL']); expect(client.pendingCount).toBe(2);
    await expect(client.search('skills')).rejects.toThrow(/storage/);
    children[0]!.close(); expect(await a).toMatchObject({ message: expect.stringContaining('timeout') }); expect(client.pendingCount).toBe(1);
    children[1]!.close(); expect(await b).toMatchObject({ message: expect.stringContaining('invalid_response') }); expect(client.pendingCount).toBe(0); await client.close();
  });

  it('refuses invalid requests without launching and drains a pending child on close', async () => {
    const { client } = fixture();
    await expect(client.search(' '.repeat(121))).rejects.toThrow(/invalid_request/);
    await expect(client.preview({ repository: '../bad/repo', skill: 'x' })).rejects.toThrow(/invalid_request/);
    expect(children).toHaveLength(0);
    const pending = client.search('react').catch(error => error);
    const closing = client.close(); await setImmediate(); expect(client.pendingCount).toBe(1); expect(children[0]!.signals).toEqual(['SIGKILL']);
    children[0]!.close(); await closing; expect(await pending).toMatchObject({ message: expect.stringContaining('timeout') });
  });
});
