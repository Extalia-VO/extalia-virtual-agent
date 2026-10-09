import { SLUG_PATTERN } from './validation.js';

/**
 * Session sources are open identifiers so importer plugins can add their own.
 * The entries below only provide display names for sources Extalia plans to
 * support; listing a source does not mean an importer for it is available.
 */
export interface SourceInfo {
  id: string;
  label: string;
}

export const KNOWN_SOURCES: readonly SourceInfo[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'hermes', label: 'Hermes Agent' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'antigravity-ide', label: 'Antigravity IDE' },
  { id: 'antigravity-cli', label: 'Antigravity CLI' },
  { id: 'extalia', label: 'Extalia' },
];

export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function sourceLabel(id: string): string {
  return KNOWN_SOURCES.find(source => source.id === id)?.label ?? id;
}
