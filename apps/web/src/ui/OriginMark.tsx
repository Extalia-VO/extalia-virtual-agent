import type { CSSProperties } from 'react';
import type { AgentOrigin, OriginMark as OriginMarkId } from '../office/agentOrigin';
import { RuntimeIcon } from '../setup/RuntimeIcon';
import { Icon } from './Icon';

/** Brand artwork the repository already ships, drawn as a single-colour mask so it follows the text colour in every theme. */
const MASKS: Partial<Record<OriginMarkId, string>> = {
  codex: '/brand/providers/png/openai-light.png',
  'claude-code': '/brand/providers/claude.svg',
  antigravity: '/brand/providers/png/antigravity-light.png',
  hermes: '/brand/hermes-logo.svg',
};

/** v0.0.37: a small monochrome mark for where an agent comes from (Codex, Claude Code, Gemini CLI, Antigravity, Hermes, Extalia Native). */
export function OriginMark({ mark }: { mark: OriginMarkId }) {
  if (mark === 'extalia-native') return <span className="origin-mark" aria-hidden="true"><RuntimeIcon runtime="extalia-native" /></span>;
  const mask = MASKS[mark];
  if (mask) return <span className="origin-mark origin-mark-mask" aria-hidden="true" style={{ '--origin-mask': `url("${mask}")` } as CSSProperties} />;
  if (mark === 'gemini-cli') {
    // A plain four-point spark, not a third-party logo file.
    return <svg className="origin-mark" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path fill="currentColor" d="M8 0.8c.5 3.7 3.5 6.7 7.2 7.2-3.7.5-6.7 3.5-7.2 7.2C7.5 11.5 4.5 8.5.8 8 4.5 7.5 7.5 4.5 8 .8Z" />
    </svg>;
  }
  return <span className="origin-mark" aria-hidden="true"><Icon name="terminal" /></span>;
}

/** Adaptive light/dark brand logo for an agent app row or setup card. */
export function AgentAppLogo({ app, size = 16 }: { app: string; size?: number }) {
  switch (app) {
    case 'codex':
    case 'Codex':
      return (
        <span className="runtime-logo-adaptive" aria-hidden="true">
          <img src="/brand/providers/png/openai-dark.png" alt="" width={size} height={size} className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/openai-light.png" alt="" width={size} height={size} className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );
    case 'claude':
    case 'claude-code':
    case 'Claude Code':
      return (
        <span className="runtime-logo-adaptive" aria-hidden="true">
          <img src="/brand/providers/claude-dark.svg" alt="" width={size} height={size} className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/claude-light.svg" alt="" width={size} height={size} className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );
    case 'antigravity':
    case 'Antigravity':
      return (
        <span className="runtime-logo-adaptive" aria-hidden="true">
          <img src="/brand/providers/png/antigravity-dark.png" alt="" width={size} height={size} className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/antigravity-light.png" alt="" width={size} height={size} className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );
    case 'hermes':
    case 'Hermes':
      return <RuntimeIcon runtime="hermes" size={size} />;
    case 'gemini':
    case 'gemini-cli':
    case 'Gemini CLI':
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} style={{ display: 'block' }} aria-hidden="true">
          <path fill="currentColor" d="M8 0.8c.5 3.7 3.5 6.7 7.2 7.2-3.7.5-6.7 3.5-7.2 7.2C7.5 11.5 4.5 8.5.8 8 4.5 7.5 7.5 4.5 8 .8Z" />
        </svg>
      );
    default:
      return <Icon name="terminal" />;
  }
}

/** Source chip: mark plus label; `channel` text (already translated) goes into the tooltip and, when `showChannel`, the chip itself. */
export function OriginChip({ origin, channel, showChannel = false, iconOnly = false }: {
  origin: AgentOrigin; channel?: string | undefined; showChannel?: boolean; iconOnly?: boolean;
}) {
  const title = channel ? `${origin.label} · ${channel}` : origin.label;
  return <span className="origin-chip" data-mark={origin.mark} data-icon-only={iconOnly || undefined} title={title}>
    <OriginMark mark={origin.mark} />
    {iconOnly ? <span className="visually-hidden">{title}</span> : <span className="origin-chip-label">{origin.label}{showChannel && channel ? <span className="origin-chip-channel"> · {channel}</span> : null}</span>}
  </span>;
}
