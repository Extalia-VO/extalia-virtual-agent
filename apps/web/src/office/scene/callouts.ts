/**
 * A character's quick reply when the user picks it on the board or a lead
 * card ("Yes, I'm here!"), so it is easy to spot among the others. A flash
 * bubble only: it reports nothing about work and never touches a session.
 * Phrases come from the current language's pool (`characterCallouts` in
 * i18n), with a short recent-history window to keep repeated picks varied.
 */

/** How long a reply stays up. */
export const CALLOUT_MS = 2500;
const RECENT_CALLOUTS = 12;
const RECENT_PER_CHARACTER = 4;
const MAX_CHARACTER_HISTORY = 128;

/**
 * A phrase from `pool` that differs from every phrase in `avoid` when the pool
 * allows it; `avoid` is newest/most important first and `random` is in [0, 1).
 * Small pools fall back to their least-recently avoided phrase, rather than
 * immediately repeating the newest one. Duplicates never bias the draw.
 */
export function pickCallout(pool: readonly string[], avoid: readonly (string | undefined)[], random: number): string {
  const unique = [...new Set(pool)];
  if (!unique.length) return '';
  const fresh = unique.filter(text => !avoid.includes(text));
  const oldest = fresh.length ? -1 : Math.max(...unique.map(text => avoid.indexOf(text)));
  const choices = fresh.length ? fresh : unique.filter(text => avoid.indexOf(text) === oldest);
  const draw = Number.isFinite(random) ? Math.max(0, random) : 0;
  return choices[Math.min(choices.length - 1, Math.floor(draw * choices.length))]!;
}

export interface Callout {
  readonly characterId: string;
  readonly text: string;
  /** Start time on the store's clock. */
  readonly at: number;
  /** Changes with every reply, so a repeated pick restarts the bubble. */
  readonly key: number;
}

export interface CalloutStore {
  /** Show a new reply over `characterId` from `pool`. */
  say(characterId: string, pool: readonly string[]): Callout;
  /** The character's reply while it is up. */
  current(characterId: string): Callout | undefined;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function createCalloutStore(now: () => number = () => Date.now(), random: () => number = Math.random,
  schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms)): CalloutStore {
  const active = new Map<string, Callout>();
  const recentOf = new Map<string, readonly string[]>();
  const recent: string[] = [];
  const listeners = new Set<() => void>();
  let revision = 0;
  let keys = 0;
  const notify = () => { revision++; for (const listener of listeners) listener(); };
  return {
    say(characterId, pool) {
      const ownRecent = recentOf.get(characterId) ?? [];
      // Preserve both immediate-repeat guards when the pool permits it, then
      // avoid the wider recent history across this character and its neighbors.
      const text = pickCallout(pool, [recent.at(-1), ownRecent.at(-1), ...[...recent].reverse(), ...[...ownRecent].reverse()], random());
      recent.push(text);
      if (recent.length > RECENT_CALLOUTS) recent.shift();
      recentOf.delete(characterId);
      recentOf.set(characterId, [...ownRecent, text].slice(-RECENT_PER_CHARACTER));
      if (recentOf.size > MAX_CHARACTER_HISTORY) recentOf.delete(recentOf.keys().next().value!);
      const callout: Callout = { characterId, text, at: now(), key: ++keys };
      active.set(characterId, callout);
      notify();
      schedule(() => { if (active.get(characterId) === callout) { active.delete(characterId); notify(); } }, CALLOUT_MS);
      return callout;
    },
    current(characterId) {
      const callout = active.get(characterId);
      return callout && now() - callout.at < CALLOUT_MS ? callout : undefined;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => revision,
  };
}

/** The page's replies; the board triggers them and the scene shows them. */
export const characterCallouts = createCalloutStore();
