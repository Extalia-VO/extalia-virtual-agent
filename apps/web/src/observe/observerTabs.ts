export const OBSERVE_SECTIONS = ['sessions', 'pairing'] as const;
export type ObserveSection = typeof OBSERVE_SECTIONS[number];

export function observeTabForKey(current: ObserveSection, key: string): ObserveSection | undefined {
  const index = OBSERVE_SECTIONS.indexOf(current);
  const next = key === 'ArrowRight' ? (index + 1) % OBSERVE_SECTIONS.length
    : key === 'ArrowLeft' ? (index + OBSERVE_SECTIONS.length - 1) % OBSERVE_SECTIONS.length
      : key === 'Home' ? 0 : key === 'End' ? OBSERVE_SECTIONS.length - 1 : undefined;
  return next === undefined ? undefined : OBSERVE_SECTIONS[next];
}
