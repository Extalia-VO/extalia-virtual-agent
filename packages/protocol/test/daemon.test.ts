import { describe, expect, it } from 'vitest';
import {
  createDaemonFrameReader, DAEMON_FRAME_HEADER_BYTES, DAEMON_KNOWLEDGE_LIMITS, DAEMON_KNOWLEDGE_OPS, KNOWLEDGE_FOLDER_PATTERN, KNOWLEDGE_NODE_ID_PATTERN, KNOWLEDGE_PATH_PATTERN, KNOWLEDGE_VAULT_LABEL_PATTERN, DAEMON_MAX_FRAME_BYTES, DAEMON_OPS, DAEMON_SCHEMA_VERSION, DAEMON_SKILL_LIMITS,
  DAEMON_SKILL_OPS, DAEMON_SKILL_READ_MAX_BYTES, HOST_WORKSPACE_ID_PATTERN, SKILL_IMPORT_ORIGINS, SKILL_SCANNER_STATUSES, SKILL_USER_PRINCIPAL_PATTERN,
  SKILL_WORKSPACE_ID_MAX_LENGTH, SKILL_WORKSPACE_ID_PATTERN,
  decodeDaemonFramePayload, encodeDaemonFrame, parseDaemonFrame, type DaemonFrame, type DaemonRequest,
} from '../src/index.js';
import { utf8Length } from '../src/daemonKnowledgeRules.js';
import { UUID_PATTERN } from '../src/rules.js';
import frameFixtures from './fixtures/daemon/frames.json' with { type: 'json' };
import framingFixtures from './fixtures/daemon/framing.json' with { type: 'json' };
import routingFixtures from './fixtures/daemon/skill-routing.json' with { type: 'json' };
import planningFixtures from './fixtures/daemon/planning.json' with { type: 'json' };

interface Case { name: string; valid: boolean; value: unknown; code?: string }
const cases = [...(frameFixtures as { cases: Case[] }).cases, ...(planningFixtures as { cases: Case[] }).cases, ...(routingFixtures as { cases: Case[] }).cases];
const valid = cases.filter(item => item.valid).map(item => [item.name, item.value as DaemonFrame] as const);
const hex = (text: string) => new Uint8Array(text.match(/../g)?.map(byte => parseInt(byte, 16)) ?? []);
const requestId = '00000000-0000-4000-8000-000000000100';
const health: DaemonRequest<'health'> = { schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op: 'health', params: {} };

describe('daemon wire contract v1', () => {
  it('covers every operation with a request and a response fixture', () => {
    for (const op of DAEMON_OPS) for (const kind of ['request', 'response']) {
      expect(valid.some(([, frame]) => frame.kind === kind && 'op' in frame && frame.op === op), `${kind} ${op}`).toBe(true);
    }
  });
  it.each(valid)('round-trips %s through the length-prefixed codec', (_name, frame) => {
    const bytes = encodeDaemonFrame(frame);
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length - DAEMON_FRAME_HEADER_BYTES);
    expect(createDaemonFrameReader().push(bytes)).toEqual([{ ok: true, frame }]);
    // Byte-by-byte delivery yields the same single frame.
    const reader = createDaemonFrameReader();
    const results = Array.from(bytes).flatMap(byte => reader.push(Uint8Array.of(byte)));
    expect(results).toEqual([{ ok: true, frame }]);
    expect(reader.pending).toBe(0);
  });
  it.each(cases.filter(item => !item.valid).map(item => [item.name, item] as const))('rejects %s with a stable code and refuses to encode it', (_name, item) => {
    expect(parseDaemonFrame(item.value)).toMatchObject({ ok: false, code: item.code });
    expect(() => encodeDaemonFrame(item.value as DaemonFrame)).toThrow(item.code!);
  });
  it('correlates rejections with a valid request ID and never with an invalid one', () => {
    expect(parseDaemonFrame({ ...health, op: 'shutdown' })).toMatchObject({ ok: false, code: 'unknown_op', requestId });
    expect(parseDaemonFrame({ ...health, schemaVersion: 3 })).toMatchObject({ ok: false, code: 'unsupported_schema_version', requestId, errors: [expect.stringContaining('newer')] });
    const { requestId: _requestId, ...missing } = health;
    expect(parseDaemonFrame(missing)).not.toHaveProperty('requestId');
    expect(parseDaemonFrame({ ...health, requestId: 'REQUEST' })).not.toHaveProperty('requestId');
  });
  it('rejects unknown fields at every level, including symbol and inherited keys', () => {
    expect(parseDaemonFrame({ ...health, [Symbol('extra')]: true })).toMatchObject({ ok: false, code: 'invalid_frame' });
    expect(parseDaemonFrame(Object.assign(Object.create({ inherited: true }), health))).toMatchObject({ ok: false, code: 'invalid_frame' });
    expect(parseDaemonFrame({ ...health, params: { extra: 1 } })).toMatchObject({ ok: false, code: 'invalid_request', errors: ['frame.params.extra: unknown field.'] });
  });
});

describe('length-prefixed framing', () => {
  it.each(framingFixtures.cases.map(item => [item.name, item] as const))('%s', (_name, item) => {
    const results = createDaemonFrameReader(framingFixtures.maxFrameBytes).push(hex(item.hex));
    expect(results).toHaveLength(item.results.length);
    results.forEach((result, index) => expect(result).toMatchObject(item.results[index]!));
  });
  it('latches a fatal oversize frame and drops later input', () => {
    const reader = createDaemonFrameReader(64);
    const oversize = new Uint8Array(4);
    new DataView(oversize.buffer).setUint32(0, 65);
    const [failure] = reader.push(oversize);
    expect(failure).toMatchObject({ ok: false, code: 'frame_too_large', fatal: true });
    expect(reader.failed).toBe(true);
    expect(reader.push(encodeDaemonFrame(health))).toEqual([failure]);
    expect(reader.pending).toBe(0);
  });
  it('enforces the frame limit when encoding and bounds the configurable limit', () => {
    const bytes = encodeDaemonFrame(health);
    expect(() => encodeDaemonFrame(health, bytes.length - DAEMON_FRAME_HEADER_BYTES - 1)).toThrow(RangeError);
    expect(encodeDaemonFrame(health, bytes.length - DAEMON_FRAME_HEADER_BYTES)).toEqual(bytes);
    for (const limit of [0, 1.5, DAEMON_MAX_FRAME_BYTES + 1]) {
      expect(() => encodeDaemonFrame(health, limit)).toThrow(RangeError);
      expect(() => createDaemonFrameReader(limit)).toThrow(RangeError);
    }
    expect(DAEMON_MAX_FRAME_BYTES).toBe(framingFixtures.maxFrameBytes);
    expect(DAEMON_FRAME_HEADER_BYTES).toBe(framingFixtures.headerBytes);
  });
  it('decodes a payload with multi-byte UTF-8 and reports malformed payloads without throwing', () => {
    const frame: DaemonFrame = { schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'error', requestId, error: { code: 'conflict', message: 'Zustand veraltet: Aufgabe wurde geändert.' } };
    expect(decodeDaemonFramePayload(encodeDaemonFrame(frame).subarray(DAEMON_FRAME_HEADER_BYTES))).toEqual({ ok: true, frame });
    expect(decodeDaemonFramePayload(Uint8Array.of(0xff))).toMatchObject({ ok: false, code: 'invalid_frame', fatal: false });
    expect(decodeDaemonFramePayload(new Uint8Array(0))).toMatchObject({ ok: false, code: 'invalid_frame' });
  });
});

describe('skill registry operations', () => {
  const revisionId = `skr_${'a'.repeat(64)}`;
  const sha = 'b'.repeat(64);
  it('are part of the operation list and never accept the builtin origin', () => {
    for (const op of DAEMON_SKILL_OPS) expect(DAEMON_OPS).toContain(op);
    expect(SKILL_IMPORT_ORIGINS).not.toContain('builtin');
    const request = { schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op: 'skill.import', params: { origin: 'builtin', path: 'demo' } };
    expect(parseDaemonFrame(request)).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('only accept the local user principal for reviews and approvals', () => {
    for (const principal of ['user:local', 'user:ryan.f@example']) expect(SKILL_USER_PRINCIPAL_PATTERN.test(principal), principal).toBe(true);
    for (const principal of ['agent:lead', 'model:gpt', 'policy:auto', 'scanner:x', 'user:', 'User:local', 'user:local\n']) {
      expect(SKILL_USER_PRINCIPAL_PATTERN.test(principal), principal).toBe(false);
      const frame = { schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op: 'skill.approve', params: { revisionId, treeSha256: sha, permissionDigest: sha, principal } };
      expect(parseDaemonFrame(frame)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
  });
  it('fit the frame limit at their largest, fully escaped', () => {
    const read: DaemonFrame = {
      schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'response', requestId, op: 'skill.read',
      result: { revisionId, packageId: 'demo', path: 'SKILL.md', size: DAEMON_SKILL_READ_MAX_BYTES, sha256: sha, content: '"'.repeat(DAEMON_SKILL_READ_MAX_BYTES) },
    };
    expect(encodeDaemonFrame(read).length).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
    const segment = (index: number) => `d${String(index).padStart(3, '0')}${'x'.repeat(120)}`;
    const path = (index: number) => [0, 1, 2, 3].map(part => segment(index * 4 + part)).join('/').slice(0, 512);
    const summary = {
      packageId: 'demo', revisionId, origin: 'user' as const, version: '1.0.0', treeSha256: sha, skillMdSha256: sha, state: 'quarantined' as const,
      riskClass: 'executable' as const, manifestInferred: false, permissionDigest: sha, active: false,
      createdAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z',
      permissions: Array.from({ length: DAEMON_SKILL_LIMITS.permissions }, (_, index) => ({ capability: 'network' as const, scope: `${index}${'"'.repeat(250)}` })),
    };
    const at = '2026-10-22T10:00:00.000Z';
    const inspect: DaemonFrame = {
      schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'response', requestId, op: 'skill.inspect',
      result: {
        revision: summary, manifest: '"'.repeat(DAEMON_SKILL_LIMITS.manifest),
        files: Array.from({ length: DAEMON_SKILL_LIMITS.files }, (_, index) => ({ path: path(index), size: 1, sha256: sha, executable: false })),
        inspections: Array.from({ length: DAEMON_SKILL_LIMITS.inspections }, (_, index) => ({
          inspectionId: index + 1, scannerId: 'x'.repeat(128), scannerPin: 'x'.repeat(256), scannerVersion: 'x'.repeat(128), policyVersion: 'x'.repeat(128),
          outcome: 'completed' as const, coverage: 'complete' as const, verdict: 'none' as const, startedAt: at, finishedAt: at,
        })),
        approvals: Array.from({ length: DAEMON_SKILL_LIMITS.approvals }, (_, index) => ({
          approvalId: index + 1, kind: 'user' as const, approver: 'x'.repeat(128), status: 'revoked' as const, workspaceId: requestId, permissionDigest: sha,
          createdAt: at, expiresAt: at, revokedAt: at,
        })),
        history: Array.from({ length: DAEMON_SKILL_LIMITS.history }, (_, index) => ({ seq: index + 1, fromState: 'quarantined' as const, toState: 'inspecting' as const, reason: 'x'.repeat(64), at })),
        consent: Array.from({ length: DAEMON_SKILL_LIMITS.consent }, () => ({ path: 'SKILL.md' as const, sha256: sha, allowedAt: at })),
      },
    };
    expect(encodeDaemonFrame(inspect).length).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
  });
});

describe('skill workspace ids and the scanner report', () => {
  const revisionId = `skr_${'a'.repeat(64)}`;
  /** The host's generator, `newId('w')` in `packages/host/src/service.ts` (4 random bytes as 8 hex characters). */
  const randomHex = () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  const hostId = (millis = Date.now()) => `w_${millis.toString(36)}${randomHex()}`;
  const inspect = (workspaceId: unknown) => parseDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op: 'skill.inspect', params: { revisionId, workspaceId } });
  it('accept every id the host generates, from the epoch to the largest safe timestamp', () => {
    for (const millis of [0, 1, 35, 36, Date.UTC(2026, 9, 23), Date.now(), Date.UTC(2059, 4, 5), Number.MAX_SAFE_INTEGER]) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = hostId(millis);
        expect(HOST_WORKSPACE_ID_PATTERN.test(id), id).toBe(true);
        expect(SKILL_WORKSPACE_ID_PATTERN.test(id), id).toBe(true);
        expect(id.length).toBeLessThanOrEqual(21);
        expect(inspect(id), id).toMatchObject({ ok: true });
      }
    }
  });
  it('keep accepting the lowercase UUIDs of the first contract (additive) and nothing else', () => {
    for (const id of ['00000000-0000-4000-8000-0000000000aa', '0189f3c2-7d4e-7a1b-9c3d-5e6f7a8b9c0d']) {
      expect(UUID_PATTERN.test(id)).toBe(true);
      expect(SKILL_WORKSPACE_ID_PATTERN.test(id), id).toBe(true);
    }
    for (const id of [
      '', 'w_', 'w_1', 'w_0123abc', 'W_mh3p2k1x9f04c2a7', 'w_mh3p2k1x9F04C2A7', 'w-mh3p2k1x9f04c2a7', `w_${'z'.repeat(12)}0123abcd`, 'w_../../etc/passwd',
      'w_mh3p2k1x/f04c2a7', 'w_mh3p2k1x9f04c2a7\n', ' w_mh3p2k1x9f04c2a7', 'c_mh3p2k1x9f04c2a7', 's_mh3p2k1x9f04c2a7',
      '00000000-0000-4000-8000-0000000000AA', '00000000-0000-0000-8000-0000000000aa', '00000000000040008000000000000aa0',
    ]) {
      expect(SKILL_WORKSPACE_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
      expect(inspect(id), JSON.stringify(id)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(inspect(42)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(SKILL_WORKSPACE_ID_MAX_LENGTH).toBe(36);
  });
  it('report the scanner through an additive read-only operation', () => {
    expect(DAEMON_SKILL_OPS).toContain('skill.scanner');
    expect(DAEMON_OPS).toContain('skill.scanner');
    expect(SKILL_SCANNER_STATUSES).toEqual(['unpinned', 'ready', 'unavailable']);
    const response = (result: unknown) => parseDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'response', requestId, op: 'skill.scanner', result });
    const base = { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' };
    expect(response(base)).toMatchObject({ ok: true });
    expect(response({ ...base, pin: 'x'.repeat(257) })).toMatchObject({ ok: false, code: 'invalid_frame' });
    expect(response({ ...base, pinned: 'no' })).toMatchObject({ ok: false, code: 'invalid_frame' });
    expect(response({ ...base, scannerId: '' })).toMatchObject({ ok: false, code: 'invalid_frame' });
  });
});

describe('knowledge index operations', () => {
  const sha = 'c'.repeat(64);
  const at = '2026-10-23T10:00:00.000Z';
  const L = DAEMON_KNOWLEDGE_LIMITS;
  const response = (op: string, result: unknown) => ({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'response', requestId, op, result }) as DaemonFrame;
  const request = (op: string, params: unknown) => parseDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op, params });
  it('are part of the operation list', () => {
    for (const op of DAEMON_KNOWLEDGE_OPS) expect(DAEMON_OPS).toContain(op);
  });
  it('accept only vault-relative paths and node ids', () => {
    for (const path of ['a.md', 'Folder/Sub folder/Note (1).md', 'Ünïcode/ノート.md', 'a "quoted" name.md']) {
      expect(KNOWLEDGE_PATH_PATTERN.test(path), path).toBe(true);
      expect(KNOWLEDGE_NODE_ID_PATTERN.test(`path:${path}`), path).toBe(true);
      expect(request('knowledge.node', { path }), path).toMatchObject({ ok: true });
    }
    for (const path of ['', '/a.md', 'a//b.md', 'a/', '../a.md', './a.md', 'a/../b.md', '.hidden.md', 'a\\b.md', 'C:/a.md'.replace('/', '\\'), 'a\nb.md', 'a\u0000.md']) {
      expect(KNOWLEDGE_PATH_PATTERN.test(path), JSON.stringify(path)).toBe(false);
      expect(request('knowledge.node', { path }), JSON.stringify(path)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(request('knowledge.node', { path: `${'x'.repeat(L.path - 3)}.md` })).toMatchObject({ ok: true });
    expect(request('knowledge.node', { path: `${'x'.repeat(L.path - 2)}.md` })).toMatchObject({ ok: false, code: 'invalid_request' });
    for (const id of ['know.laravel.n-plus-one', 'a', `a${'b'.repeat(127)}`]) expect(KNOWLEDGE_NODE_ID_PATTERN.test(id), id).toBe(true);
    for (const id of ['', 'Know', `a${'b'.repeat(128)}`, 'path:', 'path:/a.md', 'file:a.md', 'a:b']) expect(KNOWLEDGE_NODE_ID_PATTERN.test(id), id).toBe(false);
  });
  it('fit the frame limit at their largest bounded results, fully escaped or multi-byte', () => {
    for (const [unit, bytesPerUnit] of [['"', 1], ['€', 3]] as const) {
      const path = `${unit.repeat(L.path - 3)}.md`;
      const node = {
        nodeId: `path:${unit.repeat(L.nodeId - 8)}.md`, idFromFrontMatter: false, path, kind: 'k'.repeat(L.kind), title: unit.repeat(L.title),
        aliases: Array.from({ length: L.listItems }, (_, index) => `${index}${unit.repeat(L.alias - 2)}`),
        tags: Array.from({ length: L.listItems }, (_, index) => `${index}${unit.repeat(L.tag - 2)}`), origin: 'vault', trustStatus: 'untrusted',
        sourceSha256: sha, sourceModifiedAt: at, observedAt: at, declaredVerification: 'v'.repeat(L.verification), declaredRevision: Number.MAX_SAFE_INTEGER,
        declaredSourceTaskIds: Array.from({ length: L.listItems }, (_, index) => `${index}${unit.repeat(L.taskId - 2)}`),
      };
      // The daemon caps the body at `bodyBytes` UTF-8 bytes; the validator bounds UTF-16 units.
      const body = unit.repeat(L.bodyBytes / bytesPerUnit);
      const frames = [
        response('knowledge.node', { generation: Number.MAX_SAFE_INTEGER, node, body, bodyStatus: 'current', bodyTruncated: true }),
        response('knowledge.sync', {
          mode: 'rebuild', at, generation: 1, notes: 1, added: 1, updated: 0, removed: 0, unchanged: 0, unresolvedLinks: 0,
          renamed: Array.from({ length: L.reportItems }, () => ({ from: path, to: path })), renamedTotal: Number.MAX_SAFE_INTEGER,
          skipped: Array.from({ length: L.reportItems }, () => ({ path, reason: 'invalid_front_matter' })), skippedTotal: Number.MAX_SAFE_INTEGER, vaultCreated: false,
        }),
        response('knowledge.search', {
          generation: 1,
          hits: Array.from({ length: L.searchLimit }, () => ({ nodeId: node.nodeId, path, title: node.title, snippet: unit.repeat(L.snippet) })),
        }),
      ];
      for (const frame of frames) {
        expect(parseDaemonFrame(frame), `${'op' in frame ? frame.op : ''} ${unit}`).toMatchObject({ ok: true });
        expect(encodeDaemonFrame(frame).length).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
      }
    }
  });
  it('need the daemon byte budget for link pages and graphs, which item limits alone do not bound', () => {
    const id = `path:${'"'.repeat(L.nodeId - 8)}.md`;
    const link = { sourceNodeId: id, ordinal: 0, edgeType: 'links_to', embed: false, line: 1, target: '"'.repeat(L.linkText), status: 'ambiguous', candidates: Array.from({ length: L.candidates }, (_, index) => `path:${index}${'"'.repeat(L.nodeId - 9 - String(index).length)}.md`) };
    const page = response('knowledge.links', { generation: 1, nodeId: id, links: Array.from({ length: L.pageLimit }, (_, ordinal) => ({ ...link, ordinal })), nodes: [] });
    expect(parseDaemonFrame(page)).toMatchObject({ ok: true });
    expect(() => encodeDaemonFrame(page)).toThrow(RangeError);
    // The overview at its item limits with the longest fields is far above one frame.
    const path = `${'"'.repeat(L.path - 3)}.md`;
    const overviewNode = {
      nodeId: `path:${path}`.slice(0, L.nodeId), title: '"'.repeat(L.title), path, kind: 'k'.repeat(L.kind), folder: '"'.repeat(L.path),
      tags: Array.from({ length: L.overviewTags }, (_, index) => `${index}${'"'.repeat(L.overviewTag - 1)}`),
      degree: Number.MAX_SAFE_INTEGER, inDegree: Number.MAX_SAFE_INTEGER, outDegree: 0, modifiedAt: '2026-10-23T10:00:00.000Z',
    };
    const overview = response('knowledge.overview', {
      generation: 1, totalNodes: L.overviewNodes, totalEdges: L.overviewEdges, truncated: false,
      nodes: Array.from({ length: L.overviewNodes }, () => overviewNode),
      edges: Array.from({ length: L.overviewEdges }, () => ({ source: overviewNode.nodeId, target: overviewNode.nodeId, type: 'links_to' })),
    });
    expect(parseDaemonFrame(overview)).toMatchObject({ ok: true });
    expect(() => encodeDaemonFrame(overview)).toThrow(RangeError);
  });
  it('bound the overview limits and describe folders relative to the vault root', () => {
    expect(request('knowledge.overview', {})).toMatchObject({ ok: true });
    expect(request('knowledge.overview', { nodeLimit: L.overviewNodes, edgeLimit: L.overviewEdges })).toMatchObject({ ok: true });
    for (const params of [{ nodeLimit: 0 }, { nodeLimit: L.overviewNodes + 1 }, { edgeLimit: L.overviewEdges + 1 }, { nodeLimit: 1.5 }, { depth: 1 }]) {
      expect(request('knowledge.overview', params), JSON.stringify(params)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    for (const folder of ['', 'a', 'Projects/Sub folder', 'Ünïcode/ノート']) expect(KNOWLEDGE_FOLDER_PATTERN.test(folder), folder).toBe(true);
    for (const folder of ['/', '/a', 'a/', 'a//b', '.hidden', 'a/../b', 'a\\b', 'a\nb']) expect(KNOWLEDGE_FOLDER_PATTERN.test(folder), JSON.stringify(folder)).toBe(false);
  });
});

describe('knowledge writes, history and memory import', () => {
  const sha = 'a'.repeat(64);
  const L = DAEMON_KNOWLEDGE_LIMITS;
  const response = (op: string, result: unknown) => ({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'response', requestId, op, result }) as DaemonFrame;
  const request = (op: string, params: unknown) => parseDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op, params });
  it('count write content in UTF-8 bytes and refuse text UTF-8 cannot carry', () => {
    const write = (content: string) => request('knowledge.write', { path: 'a.md', content, expectedSha256: null, author: 'user' });
    expect(write('x'.repeat(L.contentBytes))).toMatchObject({ ok: true });
    expect(write('x'.repeat(L.contentBytes + 1))).toMatchObject({ ok: false, code: 'invalid_request' });
    // 3 UTF-8 bytes per UTF-16 unit: within the schema's maxLength, above the byte cap.
    expect(write('€'.repeat(L.contentBytes / 2))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(write('😀'.repeat(L.contentBytes / 4))).toMatchObject({ ok: true });
    for (const lone of ['\ud800', 'a\udc00', '\ud800x']) expect(write(lone), JSON.stringify(lone)).toMatchObject({ ok: false, code: 'invalid_request' });
    // Any well-formed character is note text, control characters included (exact round trip).
    expect(write('\u0000\u0007\u001b﻿')).toMatchObject({ ok: true });
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
  });
  it('accept only the user as a wire author and a hash or null as the expected version', () => {
    for (const author of ['extalia', 'extalia:memory-import', 'external', 'User']) {
      expect(request('knowledge.write', { path: 'a.md', content: 'x', author }), author).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    for (const expectedSha256 of ['', 'A'.repeat(64), 'a'.repeat(63), 0, false]) {
      expect(request('knowledge.write', { path: 'a.md', content: 'x', expectedSha256, author: 'user' }), String(expectedSha256)).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(request('knowledge.rollback', { path: 'a.md', toSha256: sha, expectedSha256 }), String(expectedSha256)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(request('knowledge.rollback', { path: 'a.md', toSha256: sha, expectedSha256: null })).toMatchObject({ ok: true });
  });
  it('report a user-chosen vault root only by its folder name', () => {
    const status = (vaultRoot: string) => parseDaemonFrame(response('knowledge.status', { state: 'ready', vaultRoot, vaultPresent: true, generation: 0 }));
    for (const label of ['vaults/default', 'custom:Vault', 'custom:My Notes (2026)', 'custom:.hidden', `custom:${'x'.repeat(L.customLabel)}`]) {
      expect(KNOWLEDGE_VAULT_LABEL_PATTERN.test(label), label).toBe(true);
      expect(status(label), label).toMatchObject({ ok: true });
    }
    for (const label of ['/Users/me/Vault', 'custom:', 'custom:/Users/me', 'custom:a/b', 'custom:a\\b', 'custom:a\nb', 'vaults/Default', 'vault:x', `custom:${'x'.repeat(L.customLabel + 1)}`]) {
      expect(status(label), JSON.stringify(label)).toMatchObject({ ok: false, code: 'invalid_frame' });
    }
  });
  it('need the daemon byte budget for an escaped read, while the largest plain read and history fit', () => {
    const read = (body: string) => response('knowledge.read', { path: 'a.md', sha256: sha, managed: false, body, truncated: true });
    for (const unit of ['x', '€', '"']) {
      const frame = read(unit.repeat(Math.floor(L.readBytes / utf8Length(unit)!)));
      expect(parseDaemonFrame(frame), unit).toMatchObject({ ok: true });
      expect(encodeDaemonFrame(frame).length, unit).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
    }
    const escaped = read('\u0001'.repeat(L.readBytes));
    expect(parseDaemonFrame(escaped)).toMatchObject({ ok: true });
    expect(() => encodeDaemonFrame(escaped)).toThrow(RangeError);
    const path = `${'"'.repeat(L.path - 3)}.md`;
    const history = response('knowledge.history', {
      path,
      entries: Array.from({ length: L.historyLimit }, () => ({
        sha256: sha, at: '2026-10-24T09:00:00.000Z', kind: 'conflict', author: `extalia:${'a'.repeat(64)}`, previousSha256: sha, conflictPath: path,
      })),
    });
    expect(parseDaemonFrame(history)).toMatchObject({ ok: true });
    expect(encodeDaemonFrame(history).length).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
    const note = { name: '"'.repeat(L.importName), vaultPath: path, outcome: 'skipped', masked: Number.MAX_SAFE_INTEGER, reason: 'too_large' };
    const counts = { total: 1, created: 0, updated: 0, unchanged: 0, conflict: 0, pendingConflict: 0, missingInVault: 0, skipped: 1, masked: 0 };
    const imported = response('knowledge.importMemory', { notes: Array.from({ length: L.importNotes }, () => note), counts, truncated: true });
    expect(parseDaemonFrame(imported)).toMatchObject({ ok: true });
    // Worst-case names and paths need the daemon's byte budget too.
    expect(() => encodeDaemonFrame(imported)).toThrow(RangeError);
  });
  it('take the memory source from the workspace id only', () => {
    expect(request('knowledge.importMemory', { workspaceId: 'w_mfx2k3a1b2c3d4e5' })).toMatchObject({ ok: true });
    for (const params of [{}, { workspaceId: 'default' }, { workspaceId: 'w_mfx2k3a1b2c3d4e5', path: 'memory' }, { workspaceId: 'w_mfx2k3a1b2c3d4e5', profile: 'work' }]) {
      expect(request('knowledge.importMemory', params), JSON.stringify(params)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
  });
});

describe('authoritative mission snapshot bounds', () => {
  it('fits the maximum task/lease response and respects the negotiated frame bound', () => {
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const tasks = Array.from({ length: 64 }, (_, n) => ({ taskId: id(n + 1), assignedAgentId: id(1000 + n), state: 'running' as const, attempt: Number.MAX_SAFE_INTEGER }));
    const frame: DaemonFrame = {
      schemaVersion: 1, kind: 'response', requestId, op: 'mission.snapshot',
      result: { missionId: id(500), workspaceId: id(501), version: Number.MAX_SAFE_INTEGER, state: 'running', updatedAt: '2026-10-22T12:00:00.000Z', sequence: 8192, tasks,
        leases: tasks.map((task, n) => ({ leaseId: id(2000 + n), taskId: task.taskId, holderAgentId: task.assignedAgentId, acquiredAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-10-22T12:10:00.000Z' })) },
    };
    const bytes = encodeDaemonFrame(frame);
    expect(bytes.length).toBeLessThan(DAEMON_MAX_FRAME_BYTES);
    expect(createDaemonFrameReader().push(bytes)).toEqual([{ ok: true, frame }]);
    expect(createDaemonFrameReader(bytes.length - DAEMON_FRAME_HEADER_BYTES - 1).push(bytes)).toMatchObject([{ ok: false, code: 'frame_too_large', fatal: true }]);
  });
});
