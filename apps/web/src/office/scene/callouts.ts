/**
 * A character's quick reply when the user picks it on the board or a lead
 * card ("Yes, I'm here!"), so it is easy to spot among the others. A flash
 * bubble only: it reports nothing about work and never touches a session.
 * Phrases come from the current language's pool (`characterCallouts` in
 * i18n) and never repeat back to back.
 */

/** How long a reply stays up. */
export const CALLOUT_MS = 2500;

/**
 * A phrase from `pool` that differs from every phrase in `avoid` when the pool
 * allows it; `random` is in [0, 1).
 */
export function pickCallout(pool: readonly string[], avoid: readonly (string | undefined)[], random: number): string {
  if (!pool.length) return '';
  const fresh = pool.filter(text => !avoid.includes(text));
  const choices = fresh.length ? fresh : pool;
  return choices[Math.min(choices.length - 1, Math.floor(Math.max(0, random) * choices.length))]!;
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
  const lastOf = new Map<string, string>();
  const listeners = new Set<() => void>();
  let last: string | undefined;
  let revision = 0;
  let keys = 0;
  const notify = () => { revision++; for (const listener of listeners) listener(); };
  return {
    say(characterId, pool) {
      // Never the same line twice in a row, nor the line this character said last.
      const text = pickCallout(pool, [last, lastOf.get(characterId)], random());
      last = text;
      lastOf.set(characterId, text);
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
