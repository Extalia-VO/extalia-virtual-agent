import type { SkillPermissionEntry, SkillRiskClass } from '@extalia/protocol';

/** Explicit public skill discovery. Catalog metadata is not scanner, approval or activation evidence. */
export interface MarketSkillEntry {
  /** Exact provider skill identifier, independent from the display name. */
  id: string;
  name: string;
  /** Public GitHub owner/repository. */
  source: string;
  installs: number;
  url: string;
}
export interface SkillMarketSearchResult {
  provider: 'skills-sh';
  query: string;
  entries: MarketSkillEntry[];
  fetchedAt?: string;
  cached: boolean;
  stale: boolean;
  problem?: string;
}
export interface SkillMarketPreviewInput { repository: string; skill: string }
/** Package declarations resolved from the exact preview bytes. Compatibility is unevaluated. */
export interface SkillMarketManifestPreview {
  id: string;
  version: string;
  inferred: boolean;
  riskClass: SkillRiskClass;
  permissions: SkillPermissionEntry[];
  permissionsTotal: number;
  compatibility: { id: string; range: string }[];
  compatibilityTotal: number;
}
export interface SkillMarketPreview {
  reviewId: string;
  expiresAt: string;
  repository: string;
  commit: string;
  /** Repository-relative directory; empty for a root skill. */
  directory: string;
  /** github:owner/repository@<immutable commit>#<directory> */
  sourceRef: string;
  files: { path: string; size: number; sha256: string }[];
  totalBytes: number;
  treeSha256: string;
  license?: string;
  /** Older native market engines do not return this metadata. */
  manifest?: SkillMarketManifestPreview;
  warnings: string[];
}
export const SKILL_MARKET_LIMITS = { query: 120, repository: 255, skill: 512, pathSegments: 8, pathSegment: 128 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const plain = (value: string) => !/\p{Cc}/u.test(value);

/** No implicit project, prompt, profile, path or credential data is added to the user's query. */
export function normalizeSkillMarketQuery(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 512 || !plain(raw)) throw new Error('Use a single-line skill search of at most 120 characters.');
  const query = raw.trim();
  if (!query || query.length > SKILL_MARKET_LIMITS.query) throw new Error('Use a single-line skill search of 1–120 characters.');
  return query;
}
export function normalizeSkillMarketRefresh(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw new Error('Choose whether to refresh the skill catalog.');
  return raw;
}
/** URLs, revisions and arbitrary download options are not accepted as user-supplied repository authority. */
export function normalizeSkillMarketPreviewInput(raw: unknown): SkillMarketPreviewInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a public GitHub repository and skill.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'repository' && key !== 'skill')) throw new Error('Choose only a repository and skill.');
  if (typeof value.repository !== 'string' || !plain(value.repository) || typeof value.skill !== 'string' || !plain(value.skill)) throw new Error('Choose a plain repository and skill path.');
  const repository = value.repository.trim();
  if (repository.length > SKILL_MARKET_LIMITS.repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error('Use a GitHub repository in owner/repo form.');
  }
  const skill = value.skill.trim();
  const segments = skill.split('/');
  if (!skill || skill.length > SKILL_MARKET_LIMITS.skill || segments.length > SKILL_MARKET_LIMITS.pathSegments
    || segments.some(segment => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment) || segment.length > SKILL_MARKET_LIMITS.pathSegment
      || segment.endsWith('.') || DEVICE.test(segment))) throw new Error('Use a skill name or a portable repository-relative skill path.');
  return { repository, skill };
}
/** Exact host-minted review identity; callers cannot choose a branch, staged path or replacement digest at import. */
export function normalizeSkillMarketReviewId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new Error('Choose a valid prepared skill preview.');
  return raw;
}

/** A click-only public source link. No source URL, credentials, query parameters or mutable ref are accepted. */
export function skillMarketPinnedSourceUrl(preview: Pick<SkillMarketPreview, 'repository' | 'commit' | 'directory'>): string | undefined {
  if (typeof preview.repository !== 'string' || preview.repository.length > SKILL_MARKET_LIMITS.repository
    || !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/.test(preview.repository)
    || typeof preview.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(preview.commit)
    || typeof preview.directory !== 'string' || preview.directory.length > SKILL_MARKET_LIMITS.skill) return;
  const segments = preview.directory ? preview.directory.split('/') : [];
  if (segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return;
  return `https://github.com/${preview.repository}/tree/${preview.commit}${segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : ''}`;
}
