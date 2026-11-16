import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState, SkillActionResult, SkillRegistryReport, SkillRevisionDetails, SkillRevisionSummary } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { Select } from '../src/ui/Select';
import { SkillQualityPanel } from '../src/skills/SkillQualityPanel';
import { SkillRevisionRow } from '../src/skills/SkillSecurityCenter';

const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[], dirty: false,
  effects: new Map<number, { deps: unknown[]; cleanup?: (() => void) | undefined }>(), pending: [] as (() => void)[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => { const id = hooks.index++; if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[id], (next: unknown) => { const value = typeof next === 'function' ? next(hooks.state[id]) : next; if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; } }]; },
  useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => { const id = hooks.index++, prior = hooks.effects.get(id);
    if (prior?.deps.length === deps.length && prior.deps.every((value, i) => Object.is(value, deps[i]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined }; hooks.effects.set(id, next);
    hooks.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; }); },
}));
const stamp = '2026-11-16T00:00:00.000Z';
const revision = (digit: string, patch: Partial<SkillRevisionSummary> = {}): SkillRevisionSummary => ({ packageId: 'validation', revisionId: `skr_${digit.repeat(64)}`, treeSha256: digit.repeat(64),
  skillMdSha256: digit.repeat(64), origin: 'generated', version: '2.0.0', state: 'awaiting_approval', riskClass: 'declarative', manifestInferred: false,
  permissionDigest: 'd'.repeat(64), permissions: [], active: false, createdAt: stamp, updatedAt: stamp, ...patch });
const candidate = revision('a'), baseline = revision('b', { active: true, state: 'active', version: '1.0.0' });
const report: SkillRegistryReport = { mode: 'registry', status: 'ready', scanner: 'unpinned', review: false, evaluation: true, approvalTtlMs: 600_000, revisions: [candidate, baseline], truncated: false };
const detail = (patch: Partial<SkillRevisionDetails> = {}): SkillRevisionDetails => ({ revision: candidate, manifest: '{}', files: [], inspections: [], approvals: [], history: [], consent: [],
  learnedQuality: { complete: true, missingSections: [], testCount: 4, baseline, evaluation: { revisionId: candidate.revisionId, treeSha256: candidate.treeSha256,
    baselineRevisionId: baseline.revisionId, baselineTreeSha256: baseline.treeSha256, status: 'passed', passed: 4, total: 4, baselinePassed: 3, evaluatedAt: stamp, scope: 'synthetic-declarative' } }, ...patch });
const workspace: HostState['workspaces'][number] = { id: 'w_mh3p2k1x9f04c2a7', name: 'Native workspace', profileId: 'profile', mode: 'managed', runtimeId: 'extalia-native', providerProfileId: 'connection', createdAt: stamp, updatedAt: stamp };
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] { if (Array.isArray(node)) return node.flatMap(elements); if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)]; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const stop = () => { for (const effect of hooks.effects.values()) effect.cleanup?.(); hooks.effects.clear(); };
beforeEach(() => { hooks.index = 0; hooks.state = []; hooks.dirty = false; hooks.effects.clear(); hooks.pending = []; });
afterEach(stop);
function harness() {
  const result: SkillActionResult = { report, revisionId: candidate.revisionId };
  const host = { evaluateSkill: vi.fn(async () => result), inspectSkill: vi.fn(async () => detail()), approveSkill: vi.fn(), activateSkill: vi.fn() };
  const props: Parameters<typeof SkillQualityPanel>[0] = { t: MESSAGES.en, agents: host as unknown as AgentHostApi, report, revision: candidate, workspaces: [workspace], detail: detail(), onBusy: vi.fn(), onEvaluated: vi.fn() };
  const render = () => { let output: ReturnType<typeof SkillQualityPanel>;
    do { hooks.index = 0; hooks.dirty = false; output = SkillQualityPanel(props); for (const effect of hooks.pending.splice(0)) effect(); } while (hooks.dirty);
    return elements(output); };
  const open = () => { const root = render()[0]!; (root.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open: true } }); return render(); };
  const choose = () => { const select = render().find(node => node.type === Select)!; (select.props.onChange as (id: string) => void)(workspace.id); return render(); };
  const evaluate = () => { const button = render().find(node => node.type === 'button')!; (button.props.onClick as () => void)(); return render(); };
  return { host, props, render, open, choose, evaluate, result };
}

describe('explicit candidate evaluation lifecycle', () => {
  it('uses only a saved managed Native workspace and evaluates once without approving or activating', async () => {
    const h = harness();
    h.props.workspaces = [workspace, { ...workspace, id: 'observe', mode: 'observe', runtimeId: undefined, providerProfileId: undefined }, { ...workspace, id: 'hermes', runtimeId: 'hermes' }];
    const opened = h.open(), select = opened.find(node => node.type === Select)!;
    expect((select.props.options as { value: string }[]).map(option => option.value)).toEqual(['', workspace.id]);
    expect(opened.find(node => node.type === 'button')!.props.disabled).toBe(true);
    h.choose();
    const pending = deferred<SkillActionResult>(); h.host.evaluateSkill.mockReturnValueOnce(pending.promise);
    const button = h.render().find(node => node.type === 'button')!;
    (button.props.onClick as () => void)(); (button.props.onClick as () => void)();
    expect(h.host.evaluateSkill).toHaveBeenCalledExactlyOnceWith({ revisionId: candidate.revisionId, workspaceId: workspace.id });
    expect(h.render().find(node => node.type === 'button')!.props.disabled).toBe(true);
    pending.resolve(h.result); await settle();
    expect(h.props.onEvaluated).toHaveBeenCalledExactlyOnceWith(h.result, detail());
    expect(h.host.approveSkill).not.toHaveBeenCalled(); expect(h.host.activateSkill).not.toHaveBeenCalled();
    expect(h.props.onBusy).toHaveBeenNthCalledWith(1, true); expect(h.props.onBusy).toHaveBeenLastCalledWith(false);
  });

  it('requires generated, security-validated, non-active candidates before model evaluation', async () => {
    for (const patch of [{ active: true, state: 'active' as const }, { state: 'superseded' as const }, { state: 'quarantined' as const }, { state: 'review_required' as const }, { origin: 'imported' as const }]) {
      stop(); hooks.state = []; hooks.index = 0;
      const h = harness(); h.props.revision = { ...candidate, ...patch }; h.open(); h.choose(); h.evaluate(); await settle();
      expect(h.host.evaluateSkill).not.toHaveBeenCalled();
      expect(h.render().find(node => node.type === 'button')!.props.disabled).toBe(true);
    }
  });

  it('discards a late result after candidate/baseline context changes before reading or presenting it', async () => {
    const h = harness(); h.open(); h.choose(); const pending = deferred<SkillActionResult>(); h.host.evaluateSkill.mockReturnValueOnce(pending.promise);
    h.evaluate(); h.props.report = { ...report, revisions: [candidate, revision('c', { active: true, state: 'active' })] }; h.render();
    pending.resolve(h.result); await settle();
    expect(h.props.onEvaluated).not.toHaveBeenCalled(); expect(h.host.inspectSkill).not.toHaveBeenCalled();
  });

  it('keeps older hosts unavailable and incomplete packages untested', async () => {
    const h = harness(); h.props.report = { ...report, evaluation: false }; h.open();
    expect(h.render().some(node => node.type === 'button')).toBe(false);
    h.props.report = report; h.props.detail = detail({ learnedQuality: { complete: false, missingSections: ['Verification'], testCount: 0 } }); h.choose(); h.evaluate(); await settle();
    expect(h.host.evaluateSkill).not.toHaveBeenCalled();
  });
});

function row(value: SkillRevisionSummary, inspected?: SkillRevisionDetails, confirm: Parameters<typeof SkillRevisionRow>[0]['confirm'] = null) {
  const onAction = vi.fn(), onConfirm = vi.fn();
  const tree = SkillRevisionRow({ t: MESSAGES.en, revision: value, busy: false, report: { ...report, revisions: [value, baseline] }, confirm,
    ...(inspected ? { qualityDetail: inspected } : {}), onConfirm, onAction, onToggleDetails: vi.fn() });
  return { nodes: elements(tree), onAction, onConfirm };
}
describe('generated candidate promotion affordances', () => {
  it('requires inspected complete current passing evidence before generated approval', () => {
    const q = detail().learnedQuality!;
    for (const quality of [undefined, { ...q, complete: false }, { ...q, evaluation: undefined }, { ...q, evaluation: { ...q.evaluation!, status: 'failed' as const } },
      { ...q, evaluation: { ...q.evaluation!, baselineTreeSha256: 'c'.repeat(64) } }]) {
      const current = row(candidate, quality ? detail({ learnedQuality: quality }) : undefined, { kind: 'approve', revisionId: candidate.revisionId });
      const approve = current.nodes.find(node => node.type === 'button' && node.props['aria-label'] === MESSAGES.en.skillCenter.actionLabel(MESSAGES.en.skillCenter.approve, candidate.packageId, MESSAGES.en.skillCenter.version(candidate.version)))!;
      expect(approve.props.disabled).toBe(true); (approve.props.onClick as () => void)(); expect(current.onConfirm).not.toHaveBeenCalled();
      expect(current.nodes.some(node => node.props.className === 'skill-confirm')).toBe(false);
    }
    const ready = row(candidate, detail());
    const approve = ready.nodes.find(node => node.type === 'button' && node.props['aria-label'] === MESSAGES.en.skillCenter.actionLabel(MESSAGES.en.skillCenter.approve, candidate.packageId, MESSAGES.en.skillCenter.version(candidate.version)))!;
    expect(approve.props.disabled).toBe(false);
  });

  it('blocks untested generated activation while preserving imported approval and historical rollback', () => {
    const approved = row({ ...candidate, state: 'approved' });
    const activate = approved.nodes.find(node => node.type === 'button' && String(node.props['aria-label']).startsWith(MESSAGES.en.skillCenter.activate))!;
    expect(activate.props.disabled).toBe(true); (activate.props.onClick as () => void)(); expect(approved.onAction).not.toHaveBeenCalled();
    const imported = row({ ...candidate, origin: 'imported' });
    const approve = imported.nodes.find(node => node.type === 'button' && String(node.props['aria-label']).startsWith(MESSAGES.en.skillCenter.approve))!;
    expect(approve.props.disabled).toBe(false);
    const historic = row({ ...candidate, state: 'superseded' });
    const rollback = historic.nodes.find(node => node.type === 'button' && String(node.props['aria-label']).startsWith(MESSAGES.en.skillCenter.rollback))!;
    expect(rollback.props.disabled).toBe(false);
  });
});
