/**
 * Canonical Portrait Export & Asset Pipeline for Universal Gateway v2 (PRD §8.4, §14.1, §18.2 GW-FR-031..035).
 *
 * Resolves Lead (`<sessionId>:primary`) and active session TeamMember (`<sessionId>:<teamMemberId>`)
 * identities from saved `CharacterAppearance` profiles, renders deterministic bounded headless
 * SVG/PNG headshots, persists revocable TTL-scoped asset metadata in `gateway_avatar_assets`,
 * enforces public-HTTPS-only avatar URL hygiene (GW-AT-025), and guards against display-name spoofing.
 */
import {
  readCharacterAppearance,
  type CharacterAppearance,
  type CharacterHairStyle,
  type CharacterOutfit,
  type TeamMember,
} from '@extalia/core';
import {
  sanitizeGatewayText,
  validateAgentPortraitIdentity,
  type AgentPortraitIdentity,
} from '@extalia/platform';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { GatewayStore } from './store.js';

export const PORTRAIT_RENDERER_VERSION = 'v1';
export const DISCORD_MAX_USERNAME_LENGTH = 80;
export const DEFAULT_PORTRAIT_TTL_SECONDS = 3600;
export const AVATAR_UNAVAILABLE_INDICATOR = '[Avatar unavailable]';
export const AVATAR_UNAVAILABLE_DIAGNOSTIC = 'avatar-unavailable';

export interface RenderedPortraitAsset {
  assetId: string;
  characterId: string;
  workspaceId: string;
  sessionId: string;
  appearanceHash: string;
  portraitRevision: string;
  assetRef: string;
  token: string;
  format: 'svg' | 'png';
  contentType: 'image/svg+xml' | 'image/png';
  bytes: Buffer;
  sha256: string;
  expiresAt: string;
  createdAt: string;
}

export interface StoredAvatarAssetRecord {
  id: string;
  characterId: string;
  workspaceId: string;
  sessionId: string;
  appearanceHash: string;
  revision: string;
  assetRef: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface PortraitDisplayNameGuardResult {
  displayName: string;
  originalName: string;
  guarded: boolean;
  reason?: string;
}

export type PublicAvatarUrlResult =
  | {
    readonly ok: true;
    readonly avatarUrl: string;
    readonly fallbackIndicator?: undefined;
    readonly diagnostic?: undefined;
  }
  | {
    readonly ok: false;
    readonly avatarUrl?: undefined;
    readonly fallbackIndicator: typeof AVATAR_UNAVAILABLE_INDICATOR;
    readonly diagnostic: typeof AVATAR_UNAVAILABLE_DIAGNOSTIC;
    readonly reason: string;
  };

export type PortraitExportResult =
  | {
    readonly ok: true;
    readonly identity: AgentPortraitIdentity;
    readonly displayName: PortraitDisplayNameGuardResult;
    readonly asset: RenderedPortraitAsset;
    readonly publicUrl: PublicAvatarUrlResult;
  }
  | {
    readonly ok: false;
    readonly code: 'UNIDENTIFIED_WORKER' | 'INVALID_APPEARANCE' | 'INVALID_IDENTITY';
    readonly reason: string;
    readonly fallbackSenderKind: 'gateway-system';
  };

export interface ResolveLeadPortraitInput {
  workspaceId: string;
  sessionId: string;
  leadName: string;
  leadRole?: string;
  appearance: CharacterAppearance;
  profileRevision?: number;
  provenance?: AgentPortraitIdentity['provenance'];
  format?: 'svg' | 'png';
  ttlSeconds?: number;
  now: string;
}

export interface ResolveWorkerPortraitInput {
  workspaceId: string;
  sessionId: string;
  workerAgentId: string;
  /** Active team roster belonging strictly to this session. */
  sessionTeamMembers: readonly TeamMember[];
  /** Saved character appearances keyed by `<sessionId>:<agentId>`. */
  appearances: Readonly<Record<string, CharacterAppearance | undefined>>;
  profileRevision?: number;
  provenance?: AgentPortraitIdentity['provenance'];
  format?: 'svg' | 'png';
  ttlSeconds?: number;
  now: string;
}

export interface GatewayPortraitServiceOptions {
  /**
   * Explicitly configured public HTTPS origin/base path for avatar asset delivery
   * (e.g. `https://assets.example.com/gateway/avatars`).
   * Any `http://`, `localhost`, loopback, or private RFC1918/ULA address is refused.
   */
  publicAssetBaseUrl?: string;
  /** Optional reachability probe hook; returning false triggers graceful fallback (GW-AT-025). */
  isAssetEndpointReachable?: () => boolean;
  defaultTtlSeconds?: number;
}

interface OutfitPalette {
  outer: string;
  top: string;
  accent: string;
  bg: string;
}

const OUTFIT_PALETTES: Readonly<Record<CharacterOutfit, OutfitPalette>> = {
  executive: { outer: '#1e293b', top: '#f8fafc', accent: '#2563eb', bg: '#e2e8f0' },
  'business-casual': { outer: '#334155', top: '#e2e8f0', accent: '#0f766e', bg: '#e0f2fe' },
  creative: { outer: '#581c87', top: '#fef3c7', accent: '#db2777', bg: '#fae8ff' },
  technical: { outer: '#1f2937', top: '#dbeafe', accent: '#0284c7', bg: '#dbeafe' },
  service: { outer: '#0f766e', top: '#f0fdfa', accent: '#f59e0b', bg: '#ccfbf1' },
  casual: { outer: '#475569', top: '#f1f5f9', accent: '#16a34a', bg: '#dcfce7' },
  ceo: { outer: '#0f172a', top: '#ffffff', accent: '#b45309', bg: '#fef3c7' },
  architect: { outer: '#27272a', top: '#e4e4e7', accent: '#4f46e5', bg: '#e0e7ff' },
};

const RESERVED_EXACT_NAMES = new Set([
  'extalia',
  'extalia gateway',
  'extalia gateway bot',
  'extalia bot',
  'extalia system',
  'extalia admin',
  'gateway',
  'gateway bot',
  'system',
  'admin',
  'administrator',
  'moderator',
  'official',
  'discord',
  'clyde',
  'everyone',
  'here',
]);

const RESERVED_SPOOF_PATTERNS: readonly RegExp[] = [
  /^extalia[\s._-]*(?:gateway|system|bot|admin|official)\b/i,
  /\b(?:discord|clyde)\b/i,
  /^(?:system|admin(?:istrator)?|moderator|official\s+bot)\b/i,
];

const ZERO_WIDTH_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Guards agent webhook display names against spoofing `Extalia Gateway`, system/admin labels,
 * Discord-prohibited substrings (`discord`, `clyde`), control characters, mass mentions,
 * and Discord's 80-character username limit while retaining the original host snapshot name.
 */
export function sanitizeDiscordAgentDisplayName(
  originalName: string,
  options?: { role?: string; kind?: 'lead' | 'worker' },
): PortraitDisplayNameGuardResult {
  const raw = String(originalName);
  const stripped = sanitizeGatewayText(raw.replace(ZERO_WIDTH_PATTERN, ''), {
    maxLength: 200,
    stripMentions: true,
    redactSecrets: true,
    redactPaths: true,
  }).text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[`*_~<>@#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedLower = stripped.toLowerCase();
  const isReserved =
    !stripped
    || RESERVED_EXACT_NAMES.has(normalizedLower)
    || RESERVED_SPOOF_PATTERNS.some(pattern => pattern.test(stripped));

  let guarded = stripped !== raw.trim();
  let reason: string | undefined = guarded ? 'Normalized unsafe display-name characters.' : undefined;
  let candidate = stripped;

  if (isReserved) {
    guarded = true;
    reason = 'Display name matched a reserved system, gateway, or platform label.';
    const safeRole = options?.role
      ? sanitizeGatewayText(options.role, { maxLength: 32, stripMentions: true }).text
        .replace(/[`*_~<>@#]/g, '')
        .replace(/\b(?:discord|clyde)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
      : '';
    const prefix = options?.kind === 'lead' ? 'Session Lead' : 'Team Worker';
    candidate = safeRole ? `${prefix} (${safeRole})` : prefix;
  }

  if (candidate.length > DISCORD_MAX_USERNAME_LENGTH) {
    guarded = true;
    reason = reason ?? `Display name exceeded Discord's ${DISCORD_MAX_USERNAME_LENGTH}-character limit.`;
    candidate = `${candidate.slice(0, DISCORD_MAX_USERNAME_LENGTH - 1).trimEnd()}…`;
  }

  if (candidate.length < 2) {
    guarded = true;
    reason = reason ?? 'Display name was shorter than Discord minimum length.';
    candidate = options?.kind === 'lead' ? 'Session Lead' : 'Team Worker';
  }

  return {
    displayName: candidate,
    originalName: raw,
    guarded,
    ...(reason ? { reason } : {}),
  };
}

/** Deterministic SHA-256 hash over canonicalized CharacterAppearance traits (no private paths/scene data). */
export function computeAppearanceHash(appearance: CharacterAppearance): string {
  const canonical = {
    presentation: appearance.presentation,
    hairStyle: appearance.hairStyle,
    hairColor: appearance.hairColor.toLowerCase(),
    skinTone: appearance.skinTone.toLowerCase(),
    outfit: appearance.outfit,
    top: appearance.top,
    bottom: appearance.bottom,
    outfitModel: appearance.outfitModel ?? null,
    outfitParts: appearance.outfitParts
      ? {
        top: appearance.outfitParts.top ?? null,
        bottom: appearance.outfitParts.bottom ?? null,
        outer: appearance.outfitParts.outer ?? null,
      }
      : null,
    topColor: appearance.topColor?.toLowerCase() ?? null,
    bottomColor: appearance.bottomColor?.toLowerCase() ?? null,
    outerColor: appearance.outerColor?.toLowerCase() ?? null,
    accentColor: appearance.accentColor?.toLowerCase() ?? null,
    stature: appearance.stature,
    heightCm: appearance.heightCm ?? null,
    gait: appearance.gait,
    accessories: {
      glasses: appearance.accessories.glasses,
      watch: appearance.accessories.watch,
      earrings: appearance.accessories.earrings,
      bag: appearance.accessories.bag,
      tie: appearance.accessories.tie,
      badge: appearance.accessories.badge,
      headphones: appearance.accessories.headphones,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateOrLocalIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrLocalHostname(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }

  // Pure numeric / hex / octal IPv4 encodings (e.g. 2130706433, 0x7f000001).
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) return true;

  const ipv4 = parseIpv4Octets(host);
  if (ipv4) return isPrivateOrLocalIpv4(ipv4);

  // IPv6 private/link-local/loopback/IPv4-mapped checks.
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/i.test(host)) return true; // link-local fe80::/10
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length);
      const mappedV4 = parseIpv4Octets(mapped);
      if (mappedV4) return isPrivateOrLocalIpv4(mappedV4);
      // Hex form e.g. ::ffff:7f00:1 or ::ffff:a00:1 or ::ffff:c0a8:101
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0]!, 16);
        const lo = Number.parseInt(hexParts[1]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPrivateOrLocalIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
        }
      }
      return true;
    }
    // Reject bare IPv6 literal unless clearly global unicast (2000::/3).
    if (!/^[23][0-9a-f]{0,3}:/i.test(host)) return true;
  }

  // Require at least one dot for public DNS hostnames.
  if (!host.includes('.')) return true;
  return false;
}

/**
 * Validates that an avatar asset base URL is explicitly HTTPS and publicly routable
 * (never `http://`, `localhost`, `127.0.0.1`, `[::1]`, or RFC1918/private IPs; GW-AT-025).
 */
export function validatePublicHttpsAssetBaseUrl(
  baseUrl: string | undefined,
): { ok: true; normalizedBaseUrl: string } | { ok: false; reason: string } {
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return { ok: false, reason: 'No public HTTPS avatar asset base URL is configured.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return { ok: false, reason: 'Avatar asset base URL is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `Avatar asset base URL must use https:// (received ${parsed.protocol}).` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Avatar asset base URL must not embed credentials.' };
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    return {
      ok: false,
      reason: `Refused non-public or local avatar host "${parsed.hostname}".`,
    };
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, normalizedBaseUrl: `${parsed.origin}${cleanPath}` };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function shadeHex(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${clamp(r * factor)}${clamp(g * factor)}${clamp(b * factor)}`;
}

function resolvePalette(appearance: CharacterAppearance): OutfitPalette {
  const base = OUTFIT_PALETTES[appearance.outfit];
  return {
    outer: appearance.outerColor ?? base.outer,
    top: appearance.topColor ?? base.top,
    accent: appearance.accentColor ?? base.accent,
    bg: base.bg,
  };
}

function hairBackSvg(style: CharacterHairStyle, hairColor: string, darkHair: string): string {
  switch (style) {
    case 'long':
    case 'long-straight':
    case 'long-bangs':
    case 'wavy':
      return `<path d="M28 54 C24 84 26 106 34 118 L94 118 C102 106 104 84 100 54 C98 28 84 18 64 18 C44 18 30 28 28 54 Z" fill="${hairColor}"/>`;
    case 'ponytail':
    case 'high-ponytail':
    case 'sleek-ponytail':
      return `<ellipse cx="96" cy="46" rx="14" ry="26" fill="${darkHair}"/><circle cx="64" cy="48" r="32" fill="${hairColor}"/>`;
    case 'bun':
    case 'bun-bangs':
      return `<circle cx="64" cy="18" r="14" fill="${darkHair}"/><circle cx="64" cy="48" r="31" fill="${hairColor}"/>`;
    case 'afro':
    case 'curly':
      return `<circle cx="64" cy="46" r="38" fill="${hairColor}"/><circle cx="38" cy="44" r="18" fill="${hairColor}"/><circle cx="90" cy="44" r="18" fill="${hairColor}"/>`;
    case 'dreads':
    case 'dreadlocks':
      return `<rect x="28" y="34" width="72" height="72" rx="22" fill="${hairColor}"/><path d="M36 52 L36 104 M44 52 L44 106 M84 52 L84 106 M92 52 L92 104" stroke="${darkHair}" stroke-width="3"/>`;
    case 'bob':
    case 'medium':
      return `<path d="M30 50 C28 74 32 88 40 94 L88 94 C96 88 100 74 98 50 C96 28 82 20 64 20 C46 20 32 28 30 50 Z" fill="${hairColor}"/>`;
    default:
      return `<path d="M34 52 C34 28 46 20 64 20 C82 20 94 28 94 52 Z" fill="${hairColor}"/>`;
  }
}

function hairFrontSvg(style: CharacterHairStyle, hairColor: string, darkHair: string): string {
  switch (style) {
    case 'side-part':
    case 'slicked-back':
      return `<path d="M36 46 C38 26 52 22 72 24 C84 26 92 34 92 46 C80 34 54 34 36 46 Z" fill="${hairColor}"/>`;
    case 'long-bangs':
    case 'bun-bangs':
    case 'bob':
      return `<path d="M35 46 C37 26 50 22 64 22 C78 22 91 26 93 46 L86 43 L74 41 L64 43 L54 41 L42 43 Z" fill="${hairColor}"/>`;
    case 'short-fade':
    case 'undercut':
    case 'textured-crop':
    case 'straight-short':
      return `<path d="M38 44 C40 26 50 22 64 22 C78 22 88 26 90 44 C78 36 50 36 38 44 Z" fill="${hairColor}"/><path d="M44 34 L54 30 L64 34 L74 30 L84 34" stroke="${darkHair}" stroke-width="2" fill="none"/>`;
    default:
      return `<path d="M36 48 C38 28 50 22 64 22 C78 22 90 28 92 48 C82 36 46 36 36 48 Z" fill="${hairColor}"/>`;
  }
}

function glassesSvg(glasses: CharacterAppearance['accessories']['glasses']): string {
  switch (glasses) {
    case 'rectangular':
      return `<rect x="42" y="54" width="17" height="11" rx="2" fill="none" stroke="#1e293b" stroke-width="2.4"/><rect x="69" y="54" width="17" height="11" rx="2" fill="none" stroke="#1e293b" stroke-width="2.4"/><line x1="59" y1="59" x2="69" y2="59" stroke="#1e293b" stroke-width="2"/>`;
    case 'round':
      return `<circle cx="51" cy="59" r="8" fill="none" stroke="#1e293b" stroke-width="2.4"/><circle cx="77" cy="59" r="8" fill="none" stroke="#1e293b" stroke-width="2.4"/><line x1="59" y1="59" x2="69" y2="59" stroke="#1e293b" stroke-width="2"/>`;
    case 'rimless':
      return `<rect x="43" y="55" width="16" height="9" rx="2" fill="#ffffff" fill-opacity="0.22" stroke="#64748b" stroke-width="1.2"/><rect x="69" y="55" width="16" height="9" rx="2" fill="#ffffff" fill-opacity="0.22" stroke="#64748b" stroke-width="1.2"/><line x1="59" y1="59" x2="69" y2="59" stroke="#64748b" stroke-width="1.2"/>`;
    case 'none':
      return '';
  }
}

/**
 * Renders a deterministic, bounded headless SVG headshot strictly from saved
 * `CharacterAppearance` traits. Contains zero scripts, external URLs, names, or paths.
 */
export function renderHeadshotSvg(appearance: CharacterAppearance): string {
  const palette = resolvePalette(appearance);
  const darkHair = shadeHex(appearance.hairColor, 0.72);
  const skinShadow = shadeHex(appearance.skinTone, 0.88);
  const jawRx = appearance.presentation === 'feminine' ? 22 : 24;
  const collar = appearance.top === 'turtleneck'
    ? `<rect x="52" y="84" width="24" height="16" rx="4" fill="${palette.top}"/>`
    : `<path d="M46 92 L64 108 L82 92 L76 86 L64 96 L52 86 Z" fill="${palette.top}"/>`;
  const tie = appearance.accessories.tie && (appearance.top === 'shirt' || appearance.top === 'blouse')
    ? `<path d="M61 96 L67 96 L69 122 L64 126 L59 122 Z" fill="${palette.accent}"/>`
    : '';
  const badge = appearance.accessories.badge
    ? `<rect x="78" y="106" width="12" height="8" rx="1.5" fill="#f8fafc" stroke="${palette.accent}" stroke-width="1.5"/>`
    : '';
  const earrings = appearance.accessories.earrings === 'studs'
    ? `<circle cx="38" cy="66" r="2.2" fill="${palette.accent}"/><circle cx="90" cy="66" r="2.2" fill="${palette.accent}"/>`
    : appearance.accessories.earrings === 'hoops'
      ? `<circle cx="38" cy="69" r="4" fill="none" stroke="${palette.accent}" stroke-width="1.8"/><circle cx="90" cy="69" r="4" fill="none" stroke="${palette.accent}" stroke-width="1.8"/>`
      : '';
  const headphones = appearance.accessories.headphones
    ? `<path d="M34 58 C34 26 94 26 94 58" fill="none" stroke="#334155" stroke-width="4"/><rect x="30" y="52" width="7" height="18" rx="3" fill="${palette.accent}"/><rect x="91" y="52" width="7" height="18" rx="3" fill="${palette.accent}"/>`
    : '';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Agent portrait">',
    `<rect width="128" height="128" rx="24" fill="${palette.bg}"/>`,
    hairBackSvg(appearance.hairStyle, appearance.hairColor, darkHair),
    `<path d="M20 128 C24 98 40 90 64 90 C88 90 104 98 108 128 Z" fill="${palette.outer}"/>`,
    `<rect x="55" y="76" width="18" height="18" rx="6" fill="${skinShadow}"/>`,
    collar,
    tie,
    badge,
    `<ellipse cx="64" cy="58" rx="${jawRx}" ry="26" fill="${appearance.skinTone}"/>`,
    earrings,
    `<circle cx="53" cy="59" r="2.6" fill="#0f172a"/><circle cx="75" cy="59" r="2.6" fill="#0f172a"/>`,
    `<path d="M56 71 Q64 76 72 71" fill="none" stroke="${skinShadow}" stroke-width="2.2" stroke-linecap="round"/>`,
    hairFrontSvg(appearance.hairStyle, appearance.hairColor, darkHair),
    glassesSvg(appearance.accessories.glasses),
    headphones,
    '</svg>',
  ].join('');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Renders a deterministic, bounded 64x64 RGBA PNG headshot directly from saved
 * `CharacterAppearance` traits using pure Node zlib (zero external image binaries).
 */
export function renderHeadshotPng(appearance: CharacterAppearance): Buffer {
  const size = 64;
  const palette = resolvePalette(appearance);
  const bg = hexToRgb(palette.bg);
  const outer = hexToRgb(palette.outer);
  const top = hexToRgb(palette.top);
  const accent = hexToRgb(palette.accent);
  const skin = hexToRgb(appearance.skinTone);
  const hair = hexToRgb(appearance.hairColor);
  const eye: [number, number, number] = [15, 23, 42];
  const frame: [number, number, number] = [30, 41, 59];

  const isLongHair = [
    'long', 'wavy', 'long-straight', 'long-bangs', 'dreads', 'dreadlocks', 'bob', 'medium',
  ].includes(appearance.hairStyle);
  const hasBun = appearance.hairStyle === 'bun' || appearance.hairStyle === 'bun-bangs';
  const hasAfro = appearance.hairStyle === 'afro' || appearance.hairStyle === 'curly';
  const jawRx = appearance.presentation === 'feminine' ? 11 : 12.5;

  // Each scanline starts with filter byte 0 followed by size * 4 RGBA bytes.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 4);
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x++) {
      let rgb = bg;
      const dx = x - 32;
      const dyFace = y - 29;
      const faceDist = (dx * dx) / (jawRx * jawRx) + (dyFace * dyFace) / (13 * 13);
      const hairDist = (dx * dx) / ((hasAfro ? 20 : 16) ** 2) + ((y - 24) * (y - 24)) / ((hasAfro ? 19 : 15) ** 2);

      // Back hair silhouette
      if (hairDist <= 1 || (isLongHair && Math.abs(dx) <= 17 && y >= 24 && y <= 56)) {
        rgb = hair;
      }
      if (hasBun && (dx * dx + (y - 9) * (y - 9)) <= 49) {
        rgb = hair;
      }

      // Shoulders / outfit
      if (y >= 45 && ((dx * dx) / (23 * 23) + ((y - 64) * (y - 64)) / (20 * 20) <= 1)) {
        rgb = outer;
        if (Math.abs(dx) <= 8 && y <= 55) rgb = top;
        if (appearance.accessories.tie && Math.abs(dx) <= 2 && y >= 48) rgb = accent;
        if (appearance.accessories.badge && x >= 39 && x <= 46 && y >= 52 && y <= 56) rgb = accent;
      }

      // Neck & head
      if (Math.abs(dx) <= 4 && y >= 39 && y <= 48) rgb = skin;
      if (faceDist <= 1) rgb = skin;

      // Top/front hair crown
      if (faceDist <= 1.1 && y <= 23 + (Math.abs(dx) > 7 ? 3 : 0)) {
        rgb = hair;
      }

      // Eyes
      if ((Math.abs(x - 27) <= 1 && Math.abs(y - 29) <= 1) || (Math.abs(x - 37) <= 1 && Math.abs(y - 29) <= 1)) {
        rgb = eye;
      }

      // Glasses frames
      if (appearance.accessories.glasses !== 'none') {
        const leftBox = x >= 22 && x <= 30 && y >= 26 && y <= 32 && (x === 22 || x === 30 || y === 26 || y === 32);
        const rightBox = x >= 34 && x <= 42 && y >= 26 && y <= 32 && (x === 34 || x === 42 || y === 26 || y === 32);
        const bridge = y === 29 && x >= 31 && x <= 33;
        if (leftBox || rightBox || bridge) rgb = frame;
      }

      // Headphones
      if (appearance.accessories.headphones) {
        const cup = (x >= 16 && x <= 19 || x >= 45 && x <= 48) && y >= 25 && y <= 34;
        if (cup) rgb = accent;
      }

      const px = rowOffset + 1 + x * 4;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mapAssetRow(row: Record<string, unknown>): StoredAvatarAssetRecord {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    appearanceHash: String(row.appearance_hash),
    revision: String(row.revision),
    assetRef: String(row.asset_ref),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
    createdAt: String(row.created_at),
  };
}

export class GatewayPortraitService {
  private readonly assetsByToken = new Map<string, RenderedPortraitAsset>();
  private publicAssetBaseUrl?: string;
  private readonly isAssetEndpointReachable: () => boolean;
  private readonly defaultTtlSeconds: number;

  constructor(
    private readonly store: GatewayStore,
    options: GatewayPortraitServiceOptions = {},
  ) {
    this.publicAssetBaseUrl = options.publicAssetBaseUrl;
    this.isAssetEndpointReachable = options.isAssetEndpointReachable ?? (() => true);
    this.defaultTtlSeconds = Math.max(60, Math.min(options.defaultTtlSeconds ?? DEFAULT_PORTRAIT_TTL_SECONDS, 86_400));
  }

  setPublicAssetBaseUrl(baseUrl: string | undefined): void {
    this.publicAssetBaseUrl = baseUrl;
  }

  /**
   * Builds a public-safe HTTPS `avatar_url` ONLY from an explicitly configured HTTPS base URL.
   * Refuses `http://`, `localhost`, loopback, RFC1918/private IPs, or unreachable endpoints (GW-AT-025).
   */
  resolvePublicAvatarUrl(input: {
    token: string;
    format: 'svg' | 'png';
    expiresAt?: string;
    revokedAt?: string;
    now: string;
  }): PublicAvatarUrlResult {
    if (input.revokedAt) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: 'Portrait asset has been revoked.',
      };
    }
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: 'Portrait asset TTL has expired.',
      };
    }
    const baseCheck = validatePublicHttpsAssetBaseUrl(this.publicAssetBaseUrl);
    if (!baseCheck.ok) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: baseCheck.reason,
      };
    }
    if (!this.isAssetEndpointReachable()) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: 'Configured HTTPS portrait asset server is currently unreachable.',
      };
    }
    const ext = input.format === 'png' ? 'png' : 'svg';
    return {
      ok: true,
      avatarUrl: `${baseCheck.normalizedBaseUrl}/${encodeURIComponent(input.token)}.${ext}`,
    };
  }

  /** Resolves and exports a canonical portrait snapshot for the session Lead (`<sessionId>:primary`). */
  exportLeadPortrait(input: ResolveLeadPortraitInput): PortraitExportResult {
    return this.exportInternal({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      agentId: 'primary',
      kind: 'lead',
      name: input.leadName,
      role: input.leadRole ?? 'Lead',
      appearance: input.appearance,
      profileRevision: input.profileRevision ?? 1,
      provenance: input.provenance ?? 'host-team-roster',
      format: input.format ?? 'png',
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
  }

  /**
   * Resolves and exports a canonical portrait snapshot for an active session `TeamMember`
   * (`<sessionId>:<teamMemberId>`). Never matches workers from another session/workspace
   * and returns `UNIDENTIFIED_WORKER` (system report fallback) if the worker is not in the roster.
   */
  exportWorkerPortrait(input: ResolveWorkerPortraitInput): PortraitExportResult {
    const member = input.sessionTeamMembers.find(m => m.id === input.workerAgentId);
    if (!member) {
      return {
        ok: false,
        code: 'UNIDENTIFIED_WORKER',
        reason: `Worker "${input.workerAgentId}" is not in session "${input.sessionId}" active team roster.`,
        fallbackSenderKind: 'gateway-system',
      };
    }
    const characterId = `${input.sessionId}:${member.id}`;
    const appearance = input.appearances[characterId];
    if (!appearance) {
      return {
        ok: false,
        code: 'INVALID_APPEARANCE',
        reason: `No saved CharacterAppearance found for "${characterId}".`,
        fallbackSenderKind: 'gateway-system',
      };
    }
    return this.exportInternal({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      agentId: member.id,
      teamMemberId: member.id,
      kind: 'worker',
      name: member.name,
      role: member.role,
      appearance,
      profileRevision: input.profileRevision ?? 1,
      provenance: input.provenance ?? 'host-team-roster',
      format: input.format ?? 'png',
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
  }

  private exportInternal(input: {
    workspaceId: string;
    sessionId: string;
    agentId: string;
    teamMemberId?: string;
    kind: 'lead' | 'worker';
    name: string;
    role: string;
    appearance: CharacterAppearance;
    profileRevision: number;
    provenance: AgentPortraitIdentity['provenance'];
    format: 'svg' | 'png';
    ttlSeconds?: number;
    now: string;
  }): PortraitExportResult {
    let validatedAppearance: CharacterAppearance;
    try {
      validatedAppearance = readCharacterAppearance(input.appearance);
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_APPEARANCE',
        reason: error instanceof Error ? error.message : 'Invalid CharacterAppearance.',
        fallbackSenderKind: 'gateway-system',
      };
    }

    const characterId = `${input.sessionId}:${input.agentId}`;
    const appearanceHash = computeAppearanceHash(validatedAppearance);
    const portraitRevision = `${PORTRAIT_RENDERER_VERSION}:p${input.profileRevision}:${appearanceHash.slice(0, 12)}`;
    const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds ?? this.defaultTtlSeconds, 86_400));
    const expiresAt = new Date(Date.parse(input.now) + ttlSeconds * 1000).toISOString();

    const bytes = input.format === 'png'
      ? renderHeadshotPng(validatedAppearance)
      : Buffer.from(renderHeadshotSvg(validatedAppearance), 'utf8');
    const contentType = input.format === 'png' ? 'image/png' : 'image/svg+xml';
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const stored = this.store.transaction(() => {
      const existing = this.store.database.prepare(
        `SELECT * FROM gateway_avatar_assets
         WHERE character_id = ? AND appearance_hash = ? AND revision = ?`,
      ).get(characterId, appearanceHash, portraitRevision) as Record<string, unknown> | undefined;

      if (existing && !existing.revoked_at && (!existing.expires_at || Date.parse(String(existing.expires_at)) > Date.parse(input.now))) {
        return mapAssetRow(existing);
      }

      const assetId = `avt_${randomUUID()}`;
      const token = randomBytes(18).toString('base64url');
      const assetRef = `avatar-token:${token}`;

      if (existing) {
        // Refresh expired/revoked slot with a brand-new revocable token and TTL.
        this.store.database.prepare(
          `UPDATE gateway_avatar_assets
           SET id = ?, asset_ref = ?, expires_at = ?, revoked_at = NULL, created_at = ?
           WHERE character_id = ? AND appearance_hash = ? AND revision = ?`,
        ).run(assetId, assetRef, expiresAt, input.now, characterId, appearanceHash, portraitRevision);
      } else {
        this.store.database.prepare(
          `INSERT INTO gateway_avatar_assets(
            id, character_id, workspace_id, session_id, appearance_hash,
            revision, asset_ref, expires_at, revoked_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          assetId,
          characterId,
          input.workspaceId,
          input.sessionId,
          appearanceHash,
          portraitRevision,
          assetRef,
          expiresAt,
          input.now,
        );
      }

      const row = this.store.database
        .prepare('SELECT * FROM gateway_avatar_assets WHERE id = ?')
        .get(assetId) as Record<string, unknown>;
      return mapAssetRow(row);
    });

    const token = stored.assetRef.startsWith('avatar-token:')
      ? stored.assetRef.slice('avatar-token:'.length)
      : stored.assetRef;

    const rendered: RenderedPortraitAsset = {
      assetId: stored.id,
      characterId: stored.characterId,
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      appearanceHash: stored.appearanceHash,
      portraitRevision: stored.revision,
      assetRef: stored.assetRef,
      token,
      format: input.format,
      contentType,
      bytes,
      sha256,
      expiresAt: stored.expiresAt ?? expiresAt,
      createdAt: stored.createdAt,
    };
    this.assetsByToken.set(token, rendered);

    const identityCandidate: AgentPortraitIdentity = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      kind: input.kind,
      name: input.name,
      role: input.role,
      ...(input.teamMemberId ? { teamMemberId: input.teamMemberId } : {}),
      appearanceHash,
      portraitAssetId: stored.id,
      portraitRevision,
      profileRevision: input.profileRevision,
      provenance: input.provenance,
    };

    const validatedIdentity = validateAgentPortraitIdentity(identityCandidate);
    if (!validatedIdentity.ok) {
      return {
        ok: false,
        code: 'INVALID_IDENTITY',
        reason: validatedIdentity.error,
        fallbackSenderKind: 'gateway-system',
      };
    }

    const displayName = sanitizeDiscordAgentDisplayName(input.name, {
      role: input.role,
      kind: input.kind,
    });

    const publicUrl = this.resolvePublicAvatarUrl({
      token,
      format: input.format,
      expiresAt: stored.expiresAt,
      revokedAt: stored.revokedAt,
      now: input.now,
    });

    return {
      ok: true,
      identity: validatedIdentity.value,
      displayName,
      asset: rendered,
      publicUrl,
    };
  }

  /** Serves a read-only portrait asset by revocable token, enforcing TTL and revocation. */
  getAssetByToken(token: string, now: string): RenderedPortraitAsset | undefined {
    const assetRef = `avatar-token:${token}`;
    const row = this.store.database
      .prepare('SELECT * FROM gateway_avatar_assets WHERE asset_ref = ?')
      .get(assetRef) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = mapAssetRow(row);
    if (record.revokedAt) return undefined;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(now)) return undefined;
    return this.assetsByToken.get(token);
  }

  getStoredAsset(assetId: string): StoredAvatarAssetRecord | undefined {
    const row = this.store.database
      .prepare('SELECT * FROM gateway_avatar_assets WHERE id = ?')
      .get(assetId) as Record<string, unknown> | undefined;
    return row ? mapAssetRow(row) : undefined;
  }

  /** Resolves the public avatar URL for a previously exported `AgentPortraitIdentity` snapshot. */
  resolveAvatarUrlForIdentity(
    identity: AgentPortraitIdentity,
    now: string,
    format: 'svg' | 'png' = 'png',
  ): PublicAvatarUrlResult {
    if (!identity.portraitAssetId) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: 'Portrait identity has no exported asset id.',
      };
    }
    const stored = this.getStoredAsset(identity.portraitAssetId);
    if (!stored) {
      return {
        ok: false,
        fallbackIndicator: AVATAR_UNAVAILABLE_INDICATOR,
        diagnostic: AVATAR_UNAVAILABLE_DIAGNOSTIC,
        reason: 'Portrait asset metadata was not found.',
      };
    }
    const token = stored.assetRef.startsWith('avatar-token:')
      ? stored.assetRef.slice('avatar-token:'.length)
      : stored.assetRef;
    const cached = this.assetsByToken.get(token);
    return this.resolvePublicAvatarUrl({
      token,
      format: cached?.format ?? format,
      expiresAt: stored.expiresAt,
      revokedAt: stored.revokedAt,
      now,
    });
  }

  /** Revokes a single portrait asset token immediately and records audit trail. */
  revokeAsset(input: { assetId: string; actor: string; reason: string; now: string }): boolean {
    return this.store.transaction(() => {
      const existing = this.getStoredAsset(input.assetId);
      if (!existing || existing.revokedAt) return false;
      const res = this.store.database.prepare(
        `UPDATE gateway_avatar_assets SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      ).run(input.now, input.assetId);
      if (res.changes > 0) {
        const token = existing.assetRef.startsWith('avatar-token:')
          ? existing.assetRef.slice('avatar-token:'.length)
          : existing.assetRef;
        this.assetsByToken.delete(token);
        this.store.recordAudit({
          actor: input.actor,
          action: 'portrait.asset.revoked',
          resource: `avatar:${input.assetId}`,
          outcome: 'revoked',
          reason: input.reason,
          at: input.now,
        });
        return true;
      }
      return false;
    });
  }

  /** Revokes all active portrait assets belonging to a session. */
  revokeSessionAssets(input: { sessionId: string; actor: string; reason: string; now: string }): number {
    return this.store.transaction(() => {
      const rows = this.store.database
        .prepare('SELECT id, asset_ref FROM gateway_avatar_assets WHERE session_id = ? AND revoked_at IS NULL')
        .all(input.sessionId) as Array<{ id: string; asset_ref: string }>;
      if (rows.length === 0) return 0;
      const res = this.store.database
        .prepare('UPDATE gateway_avatar_assets SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
        .run(input.now, input.sessionId);
      for (const row of rows) {
        const token = row.asset_ref.startsWith('avatar-token:')
          ? row.asset_ref.slice('avatar-token:'.length)
          : row.asset_ref;
        this.assetsByToken.delete(token);
      }
      this.store.recordAudit({
        actor: input.actor,
        action: 'portrait.session_assets.revoked',
        resource: `session:${input.sessionId}`,
        outcome: 'revoked',
        reason: input.reason,
        metadata: { count: Number(res.changes) },
        at: input.now,
      });
      return Number(res.changes);
    });
  }
}
