/**
 * Skill Security Center host service (W3; ADRs 0023, 0025, 0026): the user path to the Rust
 * core's skill registry, and the model's catalog of active registry skills.
 *
 * - Exists only with the native core flag on (`nativeCore: 'rust'`); otherwise the report is
 *   `mode: 'legacy'` and W0 consent is review input only, never agent skill authority.
 * - Imports pass a user-selected source only to the bounded Rust staging port. Rust copies the folder (or a
 *   workspace's `.extalia/skills/<name>`) into `<data>/profiles/<profile>/skill-imports/<unique>`,
 *   refusing what the daemon would refuse, and sends only `<unique>` (ADR 0025 note, slice 2).
 * - Decisions (review, approve) carry the digests the user saw and the local user principal;
 *   the daemon checks both again. The host never decides a lifecycle step itself.
 * - Fail closed: when the daemon cannot answer, no user or project skill is offered to agents.
 * - The scanner banner follows the daemon's own report (`skill.scanner`), never the revisions' states.
 * - Details pass the workspaces whose W0 consent allowed exactly this SKILL.md, so the daemon stores that
 *   consent as review input (ADR 0025 §7); it never changes a state.
 */
import {
  DAEMON_SKILL_LIMITS, DAEMON_SKILL_LIST_MAX_LIMIT, SKILL_WORKSPACE_ID_PATTERN, type DaemonOp, type DaemonOperations,
  type SkillImportOrigin, type SkillRevisionSummary, type SkillScannerReport,
} from '@extalia/protocol';
import {
  SKILL_APPROVAL_TTL_MS, SKILL_USER_PRINCIPAL, normalizeSkillApproval, normalizeSkillApprovalId, normalizeSkillImportSource, normalizeSkillPackageId,
  normalizeSkillReview, normalizeSkillRevisionId, type SkillActionResult, type SkillImportSource, type SkillRegistryReport, type SkillRevisionDetails,
  normalizeSkillPreflight, normalizeSkillPreflightReport, type SkillPreflightInput, type SkillPreflightReport,
  normalizeSkillRouting, normalizeSkillRoutingReport, type SkillRoutingInput, type SkillRoutingReport,
  normalizeSkillRegistryPageInput, type SkillRegistryPage, type SkillRegistryPageInput,
} from '@extalia/platform';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from './daemon/index.js';
import { parseSkill, referenceSkill, type Skill, type SkillIdentity, type SkillReference, type SkillSource } from './skills.js';
import { normalizeSkillProposal, normalizeSkillProposalProvenance, type SkillProposalProvenance, type SkillProposalResult } from './skillLearning.js';
import { RustLearningBackend } from './rustLearning.js';

/**
 * Operations the Security Center needs. Optional: `skill.review` (core migration 0004) and `skill.scanner` (the installed
 * inspector; without it the scanner counts as unpinned).
 */
export const SKILL_REGISTRY_OPS = [
  'skill.import', 'skill.list', 'skill.inspect', 'skill.approve', 'skill.activate', 'skill.deactivate', 'skill.rollback', 'skill.revoke', 'skill.read',
] as const satisfies readonly DaemonOp[];
/** Folder below the profile directory the daemon imports from (`IMPORT_INBOX` in the daemon). */
export const SKILL_IMPORT_INBOX = 'skill-imports';
/** A real scanner runs outside the store lock; unrelated daemon calls keep their short deadline. */
export const SKILL_SCAN_DEADLINE_MS = 90_000;
/** Verification may stream the bundled scanner files; this does not widen mission/tool deadlines. */
export const SKILL_REGISTRY_DEADLINE_MS = 90_000;
/** Revisions one report carries. */
export const MAX_REPORT_REVISIONS = 500;
/** Agent inventory is separate from the smaller Security Center report page. */
export const MAX_AGENT_REVISIONS = 2048;
/**
 * Page size of `skill.list`. One below `DAEMON_SKILL_LIST_MAX_LIMIT`: the daemon of W3 slice 2 asks its store for
 * one more row than the page to detect a next page, and its store refuses more than the maximum (`limit_invalid`).
 */
const LIST_PAGE = DAEMON_SKILL_LIST_MAX_LIMIT - 1;
/** Copy caps: the daemon's default staging caps (ADR 0025 amendment), checked before copying more. */
export const SKILL_COPY_LIMITS = { fileBytes: 1024 * 1024, packageBytes: 8 * 1024 * 1024, entries: 256, depth: 8 } as const;

/** A refusal with a message safe to show; the host turns it into a user error. */
export class SkillRegistryError extends Error {
  override readonly name = 'UserError';
}

class NotServedError extends Error {}

export interface SkillRegistryOptions {
  /** The Rust core sidecar; absent when the native core flag is off (legacy mode). */
  daemon: DaemonSidecar | undefined;
  /** The data directory the daemon was started with (`--data-dir`). */
  dataDirectory: string;
  /** The daemon's profile (`--profile`). */
  profile: string;
  /** A workspace's project folder, or an error message when it has none. */
  workspaceRoot(workspaceId: string): string;
  /** Host-owned membership lookup; routing needs approval applicability, not a project folder. */
  workspaceKnown?(workspaceId: string): boolean;
  /**
   * The W0 consent of each workspace with a project folder (allowed skill name → SKILL.md SHA-256). Details
   * pass the matching workspaces to `skill.inspect`, which stores the consent as review input.
   */
  consentWorkspaces?(): Promise<SkillConsentWorkspace[]>;
  log?(line: string): void;
}

/** One workspace's W0 consent (`SkillConsentStore.allowed`). */
export interface SkillConsentWorkspace { id: string; allowed: Readonly<Record<string, string>> }

const failed = (error: unknown) => new SkillRegistryError(error instanceof Error ? error.message : 'Invalid request.');

/** Plain-language refusals by the daemon's stable reason (or error code). Never paths or contents. */
const REFUSALS: Record<string, string> = {
  scanner_unpinned: 'No verified skill scanner is configured, so the skill stays quarantined. Nothing was approved.',
  'scanner-unavailable': 'No verified skill scanner is configured, so the skill stays quarantined.',
  wrong_state: 'The skill is not in a state that allows this. Reload the list and check its state.',
  digest_mismatch: 'The skill changed after it was shown. Review the current version before deciding.',
  permission_digest_mismatch: 'The declared permissions changed after they were shown. Review them again before approving.',
  approval_mismatch: 'That approval belongs to another revision. Approve this revision first.',
  approval_expired: 'The approval expired before activation. Approve the revision again.',
  attestation_missing: 'The skill has no valid inspection yet, so it cannot be approved or activated.',
  attestation_invalid: 'The inspection is no longer valid (the scanner or policy changed). The skill must be inspected again.',
  attestation_incomplete: 'The inspection did not cover the whole package, so the skill cannot be approved.',
  version_reuse: 'Another revision of this skill already used this version. Change the version in extalia-skill.json and import again.',
  not_active: 'This skill is not active.',
  not_previously_active: 'Rollback can only return to a revision that was active before.',
  builtin: 'Built-in skills ship with the app and cannot be changed here.',
  review_unavailable: 'Recording a review is not available yet in this version of the native core.',
  unknown_op: 'Recording a review is not available yet in this version of the native core.',
  integrity: 'The stored skill no longer matches its recorded hash, so it was revoked.',
  integrity_failure: 'The stored skill no longer matches its recorded hash, so it was revoked.',
  manifest_invalid: 'extalia-skill.json (or the SKILL.md front matter) is invalid.',
  missing_skill_md: 'The folder has no SKILL.md at its top level.',
  not_a_directory: 'The skill folder no longer exists.',
  symlink: 'The package contains a symbolic link; links are not imported.',
  hard_link: 'The package contains a file with several hard links; it is not imported.',
  special_file: 'The package contains something that is not a regular file or folder.',
  hidden_entry: 'The package contains hidden files or folders (names starting with "."); they are not imported.',
  invalid_name: 'A file or folder name in the package is not allowed (use letters, digits, ".", "_" and "-").',
  path_collision: 'Two names in the package differ only by upper and lower case.',
  too_deep: 'The package has too many nested folders (at most 8).',
  file_too_large: 'A file in the package is larger than 1 MB.',
  package_too_large: 'The package is larger than 8 MB.',
  too_many_entries: 'The package has more than 256 files and folders.',
  empty: 'The folder is empty.',
  inside_store: 'The folder is inside the skill store.',
  outside_import_root: 'The package is outside the import folder.',
  changed: 'A file changed while it was imported. Try again.',
  permission_increase: 'This revision asks for more permissions than the approved one.',
  exceeds_preauthorized_grants: 'This revision asks for more permissions than are pre-authorized.',
  not_found: 'That skill revision no longer exists.',
};

function refusal(error: DaemonRequestError): SkillRegistryError {
  const known = (error.reason && REFUSALS[error.reason]) ?? REFUSALS[error.code];
  const code = error.reason ? `${error.code}: ${error.reason}` : error.code;
  return new SkillRegistryError(known ? `${known} (${code})` : `The native core refused this (${code}).`);
}

function unavailable(code: string): SkillRegistryError {
  if (code === 'not-served') return new SkillRegistryError('This native core does not serve the skill registry, so nothing changed.');
  return new SkillRegistryError(`The native core is unavailable (${code}). Refresh the library before retrying; completion of a submitted operation could not be confirmed.`);
}

/** How the model sees a registry skill's origin. */
function sourceOf(revision: Pick<SkillRevisionSummary, 'origin'>): SkillSource {
  return revision.origin === 'builtin' ? 'user' : revision.origin;
}

export class SkillRegistry {
  constructor(private readonly options: SkillRegistryOptions) {}

  /** Registry mode: a profile sidecar is configured (whether or not it is ready). */
  get enabled(): boolean { return Boolean(this.options.daemon); }

  private async client(): Promise<DaemonClient> {
    if (!this.options.daemon) throw new NotServedError();
    const client = await this.options.daemon.connect();
    if (!SKILL_REGISTRY_OPS.every(op => client.capabilities.includes(op))) throw new NotServedError();
    return client;
  }

  /** One daemon call for the user path; every failure becomes a user-safe message. */
  private async call<O extends Exclude<DaemonOp, 'hello'>>(op: O, params: DaemonOperations[O]['params']): Promise<DaemonOperations[O]['result']> {
    let client: DaemonClient;
    try { client = await this.client(); } catch (error) { throw unavailable(error instanceof DaemonUnavailableError ? error.code : 'not-served'); }
    if (op === 'skill.review' && !client.capabilities.includes('skill.review')) throw new SkillRegistryError(REFUSALS.review_unavailable);
    if (op === 'skill.routingPreview' && !client.capabilities.includes('skill.routingPreview')) throw new SkillRegistryError('Routing previews are not supported by this native core.');
    if (op === 'skill.preflight' && !client.capabilities.includes('skill.preflight')) throw new SkillRegistryError('Dependency checks are not supported by this native core.');
    try { return await client.request(op, params, SKILL_REGISTRY_DEADLINE_MS); } catch (error) {
      if (error instanceof DaemonRequestError) throw refusal(error);
      if (error instanceof DaemonUnavailableError) throw unavailable(error.code);
      throw error;
    }
  }

  private async listAll(client: DaemonClient, maximum = MAX_REPORT_REVISIONS): Promise<{ revisions: SkillRevisionSummary[]; truncated: boolean; indexGeneration: number; nextCursor?: string }> {
    const revisions: SkillRevisionSummary[] = [];
    let cursor: string | undefined;
    let generation: number | undefined;
    const seen = new Set<string>();
    for (;;) {
      const limit = Math.min(LIST_PAGE, maximum - revisions.length);
      const page = await client.request('skill.list', { limit, ...(cursor ? { cursor } : {}) }, SKILL_REGISTRY_DEADLINE_MS);
      if (page.revisions.length > limit) throw new SkillRegistryError('The skill catalog exceeded its requested page bound.');
      const indexGeneration = page.indexGeneration;
      if (generation !== undefined && generation !== indexGeneration) throw new SkillRegistryError('The skill catalog changed while loading. Reload it.');
      generation = indexGeneration;
      revisions.push(...page.revisions);
      cursor = page.nextCursor;
      if (!cursor) return { revisions, truncated: false, indexGeneration };
      if (!page.revisions.length || seen.has(cursor)) throw new SkillRegistryError('The skill catalog could not continue. Reload it.');
      seen.add(cursor);
      if (revisions.length >= maximum) return { revisions, truncated: true, indexGeneration, nextCursor: cursor };
    }
  }

  /** The Security Center's view. Never throws: an unavailable daemon is a status, not an error. */
  async report(): Promise<SkillRegistryReport> {
    const base = { scanner: 'unpinned' as const, review: false, preflight: false, approvalTtlMs: SKILL_APPROVAL_TTL_MS, revisions: [], truncated: false };
    if (!this.options.daemon) return { mode: 'legacy', status: 'off', ...base };
    try {
      const client = await this.client();
      const listed = await this.listAll(client);
      // Built-in skills ship with the app and are listed by the app, not managed here (gap-map decision 10).
      const revisions = listed.revisions.filter(revision => revision.origin !== 'builtin');
      const inspector = await this.scannerReport(client);
      return {
        mode: 'registry', status: 'ready', ...base, revisions, truncated: listed.truncated, indexGeneration: listed.indexGeneration,
        ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
        scanner: inspector?.status === 'ready' && inspector.pinned ? 'pinned' : 'unpinned', ...(inspector ? { inspector } : {}),
        review: client.capabilities.includes('skill.review'),
        rescan: client.capabilities.includes('skill.rescan'),
        preflight: client.capabilities.includes('skill.preflight'),
        routingPreview: client.capabilities.includes('skill.routingPreview'),
      };
    } catch (error) {
      const reason = error instanceof DaemonUnavailableError ? error.code : error instanceof DaemonRequestError ? error.code : 'not-served';
      return { mode: 'registry', status: 'unavailable', unavailableReason: reason, ...base };
    }
  }

  /** Continue the current profile's metadata only; never inspect, read, activate or scan a skill. */
  async page(value: SkillRegistryPageInput): Promise<SkillRegistryPage> {
    let input: SkillRegistryPageInput;
    try { input = normalizeSkillRegistryPageInput(value); } catch (error) { throw failed(error); }
    const result = await this.call('skill.list', { cursor: input.cursor, limit: LIST_PAGE });
    return { ...result, revisions: result.revisions.filter(revision => revision.origin !== 'builtin') };
  }

  /** Routing observes the registry only; inspect() would record consent review input. */
  async routingPreview(value: SkillRoutingInput): Promise<SkillRoutingReport> {
    let input: SkillRoutingInput;
    try {
      input = normalizeSkillRouting(value);
      if (input.workspaceId !== undefined) {
        if (this.options.workspaceKnown) {
          if (!this.options.workspaceKnown(input.workspaceId)) throw new SkillRegistryError('Unknown workspace.');
        } else this.options.workspaceRoot(input.workspaceId);
      }
    } catch (error) { throw failed(error); }
    return normalizeSkillRoutingReport(await this.call('skill.routingPreview', input), input);
  }

  /** Read only: do not call inspect() here; that method records consent review input. */
  async preflight(value: SkillPreflightInput): Promise<SkillPreflightReport> {
    let input: SkillPreflightInput;
    try { input = normalizeSkillPreflight(value); } catch (error) { throw failed(error); }
    return normalizeSkillPreflightReport(await this.call('skill.preflight', input), input.rootRevisionId);
  }

  /** The daemon's installed inspector, or undefined when it does not serve `skill.scanner` (an older daemon) or refuses it. */
  private async scannerReport(client: DaemonClient): Promise<SkillScannerReport | undefined> {
    if (!client.capabilities.includes('skill.scanner')) return undefined;
    try { return await client.request('skill.scanner', {}, SKILL_REGISTRY_DEADLINE_MS); } catch (error) {
      if (error instanceof DaemonUnavailableError) throw error;
      this.options.log?.(`The native core did not report its skill scanner (${error instanceof DaemonRequestError ? error.code : 'error'}).`);
      return undefined;
    }
  }

  private async action(result: Omit<SkillActionResult, 'report'>): Promise<SkillActionResult> {
    return { ...result, report: await this.report() };
  }

  /**
   * One revision's details. When a workspace's W0 consent allowed exactly this SKILL.md (same package name and
   * SHA-256) and the daemon has not stored that input yet, the revision is inspected again with that workspace so the
   * daemon records the consent as review input; the last answer lists every stored input.
   */
  async inspect(rawRevisionId: unknown): Promise<SkillRevisionDetails> {
    let revisionId: string;
    try { revisionId = normalizeSkillRevisionId(rawRevisionId); } catch (error) { throw failed(error); }
    let details = await this.call('skill.inspect', { revisionId });
    const { packageId, skillMdSha256, origin } = details.revision;
    if (origin === 'builtin' || !this.options.consentWorkspaces) return details;
    let workspaces: SkillConsentWorkspace[];
    try { workspaces = await this.options.consentWorkspaces(); } catch {
      this.options.log?.('Project skill consent could not be read; it is not shown as review input.');
      return details;
    }
    const stored = new Set(details.consent.map(input => input.workspaceId));
    const matching = workspaces
      .filter(workspace => SKILL_WORKSPACE_ID_PATTERN.test(workspace.id) && !stored.has(workspace.id) && workspace.allowed[packageId] === skillMdSha256)
      .slice(0, DAEMON_SKILL_LIMITS.consent);
    for (const workspace of matching) {
      // Review input is information only: a daemon that refuses it (for example one that still requires UUID
      // workspace ids) leaves the details as they were.
      try { details = await this.call('skill.inspect', { revisionId, workspaceId: workspace.id }); } catch (error) {
        if (!(error instanceof SkillRegistryError)) throw error;
        this.options.log?.('Project skill consent was not recorded as review input by the native core.');
        break;
      }
    }
    return details;
  }

  /** Scan a stored revision only after a separate explicit user action. Details reads stay read-only. */
  async rescan(rawRevisionId: unknown): Promise<SkillActionResult> {
    let revisionId: string;
    try { revisionId = normalizeSkillRevisionId(rawRevisionId); } catch (error) { throw failed(error); }
    let client: DaemonClient;
    try { client = await this.client(); } catch (error) { throw unavailable(error instanceof DaemonUnavailableError ? error.code : 'not-served'); }
    if (!client.capabilities.includes('skill.rescan')) throw new SkillRegistryError('This native core does not support rescanning stored skills.');
    try {
      const result = await client.request('skill.rescan', { revisionId }, SKILL_SCAN_DEADLINE_MS);
      return this.action(result);
    } catch (error) {
      if (error instanceof DaemonRequestError) throw refusal(error);
      if (error instanceof DaemonUnavailableError) throw new SkillRegistryError('The rescan completion could not be confirmed. Refresh the skill details before retrying; an inspection may have been recorded.');
      throw error;
    }
  }

  /** Copy the source into the import inbox, import it, and remove the copy (the daemon keeps its own). */
  async import(raw: unknown): Promise<SkillActionResult> {
    let source: SkillImportSource;
    try { source = normalizeSkillImportSource(raw); } catch (error) { throw failed(error); }
    if (!this.options.daemon) throw unavailable('not-served');
    let folder: string, origin: SkillImportOrigin, sourceRef: string;
    if (source.kind === 'folder') {
      folder = path.resolve(source.path);
      origin = 'imported';
      sourceRef = `folder:${path.basename(folder)}`.slice(0, 512);
    } else {
      const root = this.options.workspaceRoot(source.workspaceId);
      folder = await workspaceSkillFolder(root, source.name);
      origin = 'workspace';
      sourceRef = `workspace:${source.workspaceId}/.extalia/skills/${source.name}`.slice(0, 512);
    }
    await this.refuseInsideData(folder);
    // Selection and workspace consent remain host-owned; Rust reads and stages all package bytes.
    let client: DaemonClient;
    try { client = await this.client(); } catch (error) { throw unavailable(error instanceof DaemonUnavailableError ? error.code : 'not-served'); }
    const backend = new RustLearningBackend(async () => client);
    const staged = await backend.process('skill.stageFolder', { root: folder }).catch(error => {
      if (error instanceof DaemonRequestError) throw refusal(error);
      if (error instanceof DaemonUnavailableError) throw unavailable(error.code);
      throw error;
    });
    try {
      const imported = await client.request('skill.import', { origin, path: staged.path, sourceRef }, SKILL_SCAN_DEADLINE_MS);
      return this.action({
        revisionId: imported.revisionId, packageId: imported.packageId, state: imported.state, created: imported.created,
        ...(imported.stateReason ? { stateReason: imported.stateReason } : {}),
      });
    } finally {
      await backend.process('skill.cleanup', { stageId: staged.stageId }).catch(() => undefined);
    }
  }

  /** Save a user-requested generated draft. The daemon imports/scans; this host cannot approve or activate. */
  async propose(raw: unknown, rawProvenance: SkillProposalProvenance, signal?: AbortSignal): Promise<SkillProposalResult> {
    let input, provenance: SkillProposalProvenance;
    try { input = normalizeSkillProposal(raw); provenance = normalizeSkillProposalProvenance(rawProvenance); } catch (error) { throw failed(error); }
    const cancelled = () => { if (signal?.aborted) throw new SkillRegistryError('Cancelled before importing the skill candidate.'); };
    cancelled();
    // Refuse unsupported/offline cores before any candidate directory or file is written.
    let client: DaemonClient;
    try { client = await this.client(); } catch (error) { throw unavailable(error instanceof DaemonUnavailableError ? error.code : 'not-served'); }
    cancelled();
    const backend = new RustLearningBackend(async () => client);
    const staged = await backend.process('skill.stage', { proposal: input, provenance });
    try {
      cancelled();
      const imported = await client.request('skill.import', { origin: 'generated', path: staged.path, sourceRef: `prompt:${provenance.sessionId}:${provenance.promptSha256}` }, SKILL_SCAN_DEADLINE_MS);
      const base: SkillProposalResult = { packageId: imported.packageId, revisionId: imported.revisionId, state: imported.state,
        ...(imported.stateReason ? { stateReason: imported.stateReason } : {}), created: imported.created,
        inspection: 'unavailable', activationPerformed: false, cancellationObserved: Boolean(signal?.aborted) };
      // Once import was acknowledged, always request its inspection report, even if the caller cancelled.
      // Cancellation never implies that a persistent import was rolled back or a scan succeeded.
      try {
        const details = await client.request('skill.inspect', { revisionId: imported.revisionId }, SKILL_REGISTRY_DEADLINE_MS);
        if (details.revision.revisionId !== imported.revisionId || details.revision.packageId !== imported.packageId) return base;
        const latest = [...details.inspections].sort((a, b) => b.inspectionId - a.inspectionId)[0];
        return { ...base, state: details.revision.state, stateReason: details.revision.stateReason,
          inspection: latest ? 'recorded' : 'unavailable', ...(latest ? { inspectionOutcome: latest.outcome } : {}), cancellationObserved: Boolean(signal?.aborted) };
      } catch {
        return { ...base, cancellationObserved: Boolean(signal?.aborted) };
      }
    } finally {
      await backend.process('skill.cleanup', { stageId: staged.stageId }).catch(() => undefined);
    }
  }

  private async refuseInsideData(folder: string): Promise<void> {
    const [real, data] = await Promise.all([realpath(folder).catch(() => folder), realpath(this.options.dataDirectory).catch(() => this.options.dataDirectory)]);
    if (real === data || real.startsWith(data + path.sep) || data.startsWith(real + path.sep)) {
      throw new SkillRegistryError('Choose a skill folder outside the Extalia data folder.');
    }
  }

  async review(raw: unknown): Promise<SkillActionResult> {
    let input;
    try { input = normalizeSkillReview(raw); } catch (error) { throw failed(error); }
    const result = await this.call('skill.review', { ...input, principal: SKILL_USER_PRINCIPAL });
    return this.action({ revisionId: result.revisionId, state: result.state, ...(result.stateReason ? { stateReason: result.stateReason } : {}) });
  }

  /** The user's approval of exactly the digests shown; the daemon applies the default 10-minute expiry. */
  async approve(raw: unknown): Promise<SkillActionResult> {
    let input;
    try { input = normalizeSkillApproval(raw); } catch (error) { throw failed(error); }
    const result = await this.call('skill.approve', { ...input, principal: SKILL_USER_PRINCIPAL });
    return this.action({ revisionId: result.revisionId, state: result.state, approvalId: result.approvalId, expiresAt: result.expiresAt });
  }

  async activate(rawRevisionId: unknown, rawApprovalId?: unknown): Promise<SkillActionResult> {
    let revisionId: string, approvalId: number | undefined;
    try {
      revisionId = normalizeSkillRevisionId(rawRevisionId);
      approvalId = rawApprovalId === undefined || rawApprovalId === null ? undefined : normalizeSkillApprovalId(rawApprovalId);
    } catch (error) { throw failed(error); }
    if (approvalId === undefined) {
      // The newest granted approval; the daemon re-checks expiry, digests and attestation.
      const details = await this.call('skill.inspect', { revisionId });
      approvalId = details.approvals.filter(approval => approval.status === 'granted').sort((a, b) => b.approvalId - a.approvalId)[0]?.approvalId;
      if (approvalId === undefined) throw new SkillRegistryError('Approve this revision before activating it.');
    }
    const result = await this.call('skill.activate', { revisionId, approvalId });
    return this.action({ revisionId: result.revisionId, packageId: result.packageId, state: 'active', approvalId: result.approvalId });
  }

  async deactivate(rawPackageId: unknown): Promise<SkillActionResult> {
    let packageId: string;
    try { packageId = normalizeSkillPackageId(rawPackageId); } catch (error) { throw failed(error); }
    const result = await this.call('skill.deactivate', { packageId });
    return this.action({ revisionId: result.revisionId, packageId: result.packageId, state: result.state });
  }

  async rollback(rawPackageId: unknown, rawRevisionId: unknown): Promise<SkillActionResult> {
    let packageId: string, revisionId: string;
    try { packageId = normalizeSkillPackageId(rawPackageId); revisionId = normalizeSkillRevisionId(rawRevisionId); } catch (error) { throw failed(error); }
    const result = await this.call('skill.rollback', { packageId, revisionId });
    return this.action({ revisionId: result.revisionId, packageId: result.packageId, state: 'active', approvalId: result.approvalId });
  }

  async revoke(rawRevisionId: unknown): Promise<SkillActionResult> {
    let revisionId: string;
    try { revisionId = normalizeSkillRevisionId(rawRevisionId); } catch (error) { throw failed(error); }
    const result = await this.call('skill.revoke', { revisionId });
    return this.action({ revisionId: result.revisionId, state: result.state });
  }

  /**
   * Skills of the active revisions for the model (`skill_read`), read through the daemon so the
   * bytes are verified. Throws when the daemon cannot answer: the caller then offers built-in
   * skills only (fail closed). Revisions whose SKILL.md cannot be parsed are left out.
   */
  async activeSkills(): Promise<Skill[]> {
    return (await this.activeInventory(skill => skill)).skills;
  }

  async activeCatalog(workspaceId?: string): Promise<{ skills: SkillReference[]; incomplete: boolean }> {
    return this.activeInventory(referenceSkill, workspaceId);
  }

  private async activeInventory<T>(select: (skill: Skill) => T, workspaceId?: string): Promise<{ skills: T[]; incomplete: boolean }> {
    const client = await this.client();
    const { revisions, truncated } = await this.listAll(client, MAX_AGENT_REVISIONS);
    const skills: T[] = [];
    // A profile-wide bound must not disclose the size of another workspace's inventory.
    let incomplete = workspaceId === undefined && truncated;
    for (const revision of revisions) {
      if (!revision.active || revision.origin === 'builtin' || revision.state !== 'active') continue;
      if (workspaceId !== undefined && !await this.approvedForWorkspace(client, revision, workspaceId)) continue;
      try {
        const skill = await this.readSkill(client, revision);
        skills.push(select(skill));
      } catch (error) {
        if (error instanceof DaemonUnavailableError) throw error;
        incomplete = true;
        this.options.log?.(`Skill ${revision.packageId} was not offered: its SKILL.md could not be read or parsed.`);
      }
    }
    return { skills, incomplete };
  }

  /** Fresh registry approval is workspace authority; scanner evidence and W0 consent are separate. */
  private async approvedForWorkspace(client: DaemonClient, revision: SkillRevisionSummary, workspaceId: string): Promise<boolean> {
    if (!SKILL_WORKSPACE_ID_PATTERN.test(workspaceId)) return false;
    try {
      // Do not pass workspaceId: skill.inspect's optional workspace parameter records consent review input.
      const details = await client.request('skill.inspect', { revisionId: revision.revisionId }, SKILL_REGISTRY_DEADLINE_MS);
      const current = details.revision;
      if (current.revisionId !== revision.revisionId || current.packageId !== revision.packageId || current.origin !== revision.origin
        || !current.active || current.state !== 'active' || current.treeSha256 !== revision.treeSha256
        || current.skillMdSha256 !== revision.skillMdSha256 || current.permissionDigest !== revision.permissionDigest) return false;
      const now = Date.now();
      return details.approvals.some(approval => approval.workspaceId === workspaceId && approval.status === 'granted'
        && approval.revokedAt === undefined && approval.permissionDigest === current.permissionDigest
        && Number.isFinite(Date.parse(approval.expiresAt)) && Date.parse(approval.expiresAt) > now);
    } catch {
      return false;
    }
  }

  /** Re-read an offered skill when the model asks for it: still active, bytes verified by the daemon. */
  async reload(skill: SkillIdentity, workspaceId?: string): Promise<Skill> {
    return (await this.reloadMany([skill], workspaceId))[0]!;
  }

  /** One fresh bounded active-index read per metadata page, never one per item. */
  async reloadMany(skills: readonly SkillIdentity[], workspaceId?: string): Promise<Skill[]> {
    if (!skills.length || skills.length > 10 || skills.some(skill => !skill.revisionId || !skill.sha256 || skill.source === 'builtin')) throw new Error('Invalid registry skill selection.');
    const client = await this.client();
    const { revisions } = await this.listAll(client, MAX_AGENT_REVISIONS);
    const byId = new Map(revisions.map(revision => [revision.revisionId, revision]));
    const fresh: Skill[] = [];
    for (const skill of skills) {
      const revision = byId.get(skill.revisionId!);
      if (!revision || !revision.active || revision.state !== 'active' || revision.origin === 'builtin' || revision.packageId !== skill.name
        || sourceOf(revision) !== skill.source || revision.skillMdSha256 !== skill.sha256) throw new Error('Skill revision is no longer available.');
      if (workspaceId !== undefined && !await this.approvedForWorkspace(client, revision, workspaceId)) throw new Error('Skill revision is not approved for this workspace.');
      fresh.push(await this.readSkill(client, revision));
    }
    return fresh;
  }

  private async readSkill(client: DaemonClient, revision: SkillRevisionSummary): Promise<Skill> {
    const { revisionId, packageId } = revision;
    const file = await client.request('skill.read', { revisionId, path: 'SKILL.md' }, SKILL_REGISTRY_DEADLINE_MS);
    if (file.revisionId !== revisionId || file.packageId !== packageId || file.path !== 'SKILL.md' || file.sha256 !== revision.skillMdSha256
      || file.size !== Buffer.byteLength(file.content, 'utf8') || createHash('sha256').update(file.content).digest('hex') !== file.sha256) throw new Error('Mismatched skill.');
    // The package id names the skill: it is unique per profile, unlike a front-matter name.
    const parsed = parseSkill(file.content, packageId, sourceOf(revision));
    return { ...parsed, name: packageId, sha256: file.sha256, revisionId };
  }
}

/** `<project>/.extalia/skills/<name>`, refusing links anywhere below the project folder. */
async function workspaceSkillFolder(root: string, name: string): Promise<string> {
  let current = root;
  for (const part of ['.extalia', 'skills', name]) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) throw new SkillRegistryError(`The project has no skill "${name}" in .extalia/skills.`);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SkillRegistryError(`The project skill "${name}" is not a plain folder (symbolic links are not imported).`);
  }
  return current;
}
